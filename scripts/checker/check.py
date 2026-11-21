#!/usr/bin/env python3
"""Independent package check for `onionskin done`: compares the file before the agent's run (A) with the file after (B).

Derived from the invariant checker of our engine fork (scripts/corpus/invariants.py, MIT): parts-diff, multiset-diff,
rels-check, reopen, soffice-convert, trimmed to what `done` needs. It knows nothing about the engine or about Node.

usage: check.py PRE POST FORMAT       prints one JSON object {"flags": [...], "ran": [...], "skipped": [...]} on stdout
       check.py --redline PRE POST OUT  the tracked-changes copy OUT of PRE -> POST: {"ok": bool, "why": str, "ran": [...], "skipped": [...]}
exit:  0 the check ran (flags may be present), 3 a required library is missing, 1 anything else
Environment: ONIONSKIN_SOFFICE (path to soffice), ONIONSKIN_NO_SOFFICE=1, ONIONSKIN_SOFFICE_TIMEOUT (seconds, default 90).
Run it with `python -I` so nothing from the current directory is imported. Parts are read with lxml, entity resolution and
network access off, DTD and ENTITY declarations refused (defusedxml's rule).
"""
import collections, json, os, pathlib, re, shutil, signal, subprocess, sys, tempfile, time, zipfile

try:
    from lxml import etree
    import defusedxml  # noqa: F401  (its presence is part of the contract: the venv is built with it)
except ImportError as e:  # pragma: no cover
    print(json.dumps({"error": f"missing library: {e}"}))
    sys.exit(3)

NS = {
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
    'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
    'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
    'http://schemas.openxmlformats.org/spreadsheetml/2006/main': 'x',
    'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
}
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
MAX_PART = 64 * 1024 * 1024
# elements whose loss is damage, not editing: drawings, charts, fields, content controls, equations, bookmarks, links, comment/note references
COUNTED = {
    'drawing', 'pict', 'pic', 'graphicFrame', 'chart', 'oleObj', 'fldChar', 'fldSimple', 'sdt', 'oMath', 'oMathPara',
    'bookmarkStart', 'hyperlink', 'commentReference', 'commentRangeStart', 'footnoteReference', 'endnoteReference',
    'mergeCell', 'conditionalFormatting', 'dataValidation', 'tablePart', 'definedName', 'legacyDrawing',
}
KEY_ATTRS = {'bookmarkStart': ('name',), 'hyperlink': (f'{{{REL_NS}}}id', 'anchor', 'ref'), 'commentReference': ('id',), 'commentRangeStart': ('id',),
             'footnoteReference': ('id',), 'endnoteReference': ('id',), 'definedName': ('name',), 'mergeCell': ('ref',)}


def parser():
    return etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False)


def read_part(z, name):
    info = z.getinfo(name)
    if info.file_size > MAX_PART:
        raise ValueError(f'{name} is larger than {MAX_PART} bytes')
    with z.open(name) as f:
        data = f.read(MAX_PART + 1)
    if len(data) > MAX_PART:
        raise ValueError(f'{name} is larger than {MAX_PART} bytes')
    if re.search(rb'<!(DOCTYPE|ENTITY)', data[:65536]):
        raise ValueError(f'{name} declares a DTD or entity')
    root = etree.fromstring(data, parser())
    if root.getroottree().docinfo.doctype:
        raise ValueError(f'{name} declares a DTD or entity')
    return root


def short(qn):
    if qn.startswith('{'):
        uri, local = qn[1:].split('}')
        return f'{NS.get(uri, uri)}:{local}'
    return qn


def local(el):
    return el.tag.split('}')[-1]


def flag(code, severity, **kw):
    return {'code': code, 'severity': severity, **kw}


# ---------------------------------------------------------------- parts-diff
def parts_diff(za, zb):
    a, b = set(za.namelist()), set(zb.namelist())
    return [flag('part_removed', 'error', part=n) for n in sorted(a - b)] + [flag('part_added', 'info', part=n) for n in sorted(b - a)]


# ------------------------------------------------------------- multiset-diff
def multiset(z, part):
    c = collections.Counter()
    for el in parse_iter(z, part):
        name = local(el)
        if name not in COUNTED:
            continue
        key = ''
        for k in KEY_ATTRS.get(name, ()):
            if el.get(k):
                key = el.get(k)
                break
        c[(name, key)] += 1
    return c


def parse_iter(z, part):
    return (el for el in read_part(z, part).iter() if isinstance(el.tag, str))


def multiset_diff(za, zb):
    flags = []
    for part in sorted(set(za.namelist()) & set(zb.namelist())):
        if not part.endswith('.xml') or part.startswith('[') or part.startswith('docProps/'):
            continue
        try:
            ca, cb = multiset(za, part), multiset(zb, part)
        except Exception as e:  # unparsable after, fine before: that is reported by the rels check
            flags.append(flag('part_unreadable', 'error', part=part, detail=str(e)[:200]))
            continue
        lost = collections.defaultdict(list)
        before, after = collections.Counter(), collections.Counter()
        for (name, key), n in ca.items():
            before[name] += n
            after[name] += cb.get((name, key), 0)
            if cb.get((name, key), 0) < n:
                lost[name].append(key or '(unkeyed)')
        for name, keys in lost.items():
            if after[name] < before[name]:
                flags.append(flag('count_decreased', 'warn', part=part, element=name, before=before[name], after=after[name], missing=keys[:5]))
    return flags


# ---------------------------------------------------------------- rels-check
def problem_key(f):
    return tuple(f.get(k) for k in ('code', 'part', 'rels', 'target', 'element', 'attr', 'id'))


def rels_check(z, before=None, cap=50):
    names = set(z.namelist())
    problems = []
    rels = {}
    for n in sorted(names):
        if not n.endswith('.rels'):
            continue
        src = '' if n == '_rels/.rels' else re.sub(r'(^|.*/)_rels/(.*)\.rels$', lambda m: m.group(1) + m.group(2), n)
        try:
            root = read_part(z, n)
        except Exception as e:
            problems.append(flag('part_unreadable', 'error', part=n, detail=str(e)[:200]))
            continue
        m = {}
        for r in root:
            if not isinstance(r.tag, str):
                continue
            rid, tgt, mode = r.get('Id'), r.get('Target'), r.get('TargetMode')
            m[rid] = (tgt, mode)
            if mode == 'External' or tgt is None:
                continue
            base = os.path.dirname(src)
            full = tgt.lstrip('/') if tgt.startswith('/') else os.path.normpath(os.path.join(base, tgt)).replace('\\', '/')
            full = full.split('#')[0]
            if full and full not in names:
                problems.append(flag('relationship_target_missing', 'error', rels=n, target=full))
        rels[src] = m
    for n in sorted(names):
        if not n.endswith('.xml') or n.startswith('['):
            continue
        try:
            root = read_part(z, n)
        except Exception as e:
            problems.append(flag('part_unreadable', 'error', part=n, detail=str(e)[:200]))
            continue
        have = rels.get(n, {})
        for el in root.iter():
            if not isinstance(el.tag, str):
                continue
            for k, v in el.attrib.items():
                if k.startswith('{%s}' % REL_NS) and v and v not in have:
                    problems.append(flag('relationship_id_unresolved', 'error', part=n, element=short(el.tag), attr=short(k), id=v))
                    break
    if before is not None:
        # differential: report only what the input did not already have (a file that arrived with a dangling relationship is not the agent's damage).
        # The filter runs on the full lists, then the result is capped: capping first could hide a new problem behind 50 old ones.
        known = {problem_key(p) for p in rels_check(before, cap=None)}
        problems = [p for p in problems if problem_key(p) not in known]
    return problems if cap is None else problems[:cap]


# -------------------------------------------------------------------- reopen
def reopen(path, fmt):
    try:
        if fmt == 'docx':
            import docx
            d = docx.Document(path)
            return {'ok': True, 'paragraphs': len(d.paragraphs)}
        if fmt == 'xlsx':
            import openpyxl
            wb = openpyxl.load_workbook(path)
            return {'ok': True, 'sheets': wb.sheetnames}
        if fmt == 'pptx':
            import pptx
            return {'ok': True, 'slides': len(pptx.Presentation(path).slides)}
        return {'ok': False, 'error': f'unsupported format {fmt}'}
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {str(e)[:300]}'}


# ------------------------------------------------------------ soffice-convert
def soffice_path():
    if os.environ.get('ONIONSKIN_NO_SOFFICE') == '1':
        return None, 'disabled by ONIONSKIN_NO_SOFFICE'
    p = os.environ.get('ONIONSKIN_SOFFICE') or '/Applications/LibreOffice.app/Contents/MacOS/soffice'
    return (p, None) if os.path.exists(p) else (None, 'LibreOffice is not installed')


PARENT = os.getppid()
CURRENT = []  # the running soffice (own process group), so a SIGTERM to this script can take it down too


def kill_current():
    for p in CURRENT:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass


def on_term(signum, frame):
    kill_current()
    sys.exit(1)


def soffice_convert(soffice, path, timeout, to='pdf'):
    tmp = tempfile.mkdtemp(prefix='onionskin-soffice-')
    try:
        # private profile so a LibreOffice the user has open is never touched; own process group so a hang can be killed whole
        cmd = [soffice, f'-env:UserInstallation={pathlib.Path(os.path.abspath(tmp)).as_uri()}/profile', '--headless', '--norestore', '--convert-to', to, '--outdir', tmp, path]
        pid_file = os.environ.get('ONIONSKIN_SOFFICE_PID_FILE') if os.name == 'posix' else None
        if pid_file:
            # Wait for registration before exec. If the checker dies first, EOF ends the new group.
            cmd = ['/bin/sh', '-c', 'IFS= read -r ready || exit 1; exec "$@"', 'soffice', *cmd]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE if pid_file else None, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        CURRENT.append(p)
        try:
            if pid_file:
                pathlib.Path(pid_file).write_text(f'{p.pid}\n', encoding='ascii')
                p.stdin.write(b'\n')
                p.stdin.flush()
            deadline = time.monotonic() + timeout
            while True:
                try:
                    p.communicate(timeout=0.5)
                    break
                except subprocess.TimeoutExpired:
                    if os.getppid() != PARENT:  # the server is gone (crash, kill): never leave a LibreOffice behind
                        kill_current()
                        sys.exit(1)
                    if time.monotonic() > deadline:
                        os.killpg(p.pid, signal.SIGKILL)
                        p.communicate()
                        return {'ok': False, 'timeout': True, 'error': f'timeout after {timeout}s'}
        finally:
            if p.poll() is None:
                kill_current()
                p.wait()
            if pid_file:
                pathlib.Path(pid_file).unlink(missing_ok=True)
            CURRENT.clear()
        pdf = os.path.join(tmp, os.path.splitext(os.path.basename(path))[0] + '.' + to)
        size = os.path.getsize(pdf) if os.path.exists(pdf) else 0
        return {'ok': size > 0, 'pdf_bytes': size, **({} if size else {'error': f'no pdf (exit {p.returncode})'})}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ redline
# A second resolver for the tracked-changes copy, written apart from the Node one (src/redline-check.js): lxml, no shared code. Accept All
# keeps w:ins and drops w:del; Reject All the other way round. A paragraph whose own mark is dropped must be empty and is removed.
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
q = lambda n: f'{{{W}}}{n}'


def resolve(root, keep):
    drop = 'del' if keep == 'ins' else 'ins'
    doomed = []
    for el in list(root.iter(q('ins'), q('del'))):
        parent = el.getparent()
        if parent is None:
            continue
        is_mark = parent.tag == q('rPr') and parent.getparent() is not None and parent.getparent().tag == q('pPr')
        if is_mark:
            if local(el) == drop:
                doomed.append(parent.getparent().getparent())
            parent.remove(el)
        elif local(el) == drop:
            parent.remove(el)
        else:
            idx = parent.index(el)
            for k in list(el):
                if keep == 'del':
                    for t in k.iter(q('delText')):
                        t.tag = q('t')
                parent.insert(idx, k)
                idx += 1
            parent.remove(el)
    for p in doomed:
        if p.find('.//' + q('t')) is not None:
            raise ValueError('a paragraph whose mark is removed still has text')
        nxt = p.getnext()
        if nxt is None or nxt.tag != q('p'):
            raise ValueError('a paragraph whose mark is removed has no paragraph after it')
        p.getparent().remove(p)
    return root


def para_texts(root):
    out = []
    body = root.find(q('body'))
    for p in body.iter(q('p')):
        if any(a.tag == q('p') for a in p.iterancestors()):
            continue
        text = []
        for el in p.iter():
            if any(a.tag == q('del') for a in el.iterancestors()):
                continue
            n = el.tag
            if n == q('t'):
                text.append(el.text or '')
            elif n == q('tab'):
                text.append('\t')
            elif n in (q('br'), q('cr')) and el.get(q('type')) not in ('page', 'column'):
                text.append('\n')
            elif n in (q('drawing'), q('pict')):
                text.append('\ufffc')
        out.append(''.join(text))
    return out


def redline(pre, post, out):
    ran, skipped = [], []
    doc = lambda f: read_part(zipfile.ZipFile(f), 'word/document.xml')
    want_after, want_before = para_texts(doc(post)), para_texts(doc(pre))
    if para_texts(resolve(doc(out), 'ins')) != want_after:
        return {'ok': False, 'why': 'Accept All does not give the agent\'s version', 'ran': ran, 'skipped': skipped}
    if para_texts(resolve(doc(out), 'del')) != want_before:
        return {'ok': False, 'why': 'Reject All does not give the earlier version', 'ran': ran, 'skipped': skipped}
    ran.append('redline-lxml')
    r = reopen(out, 'docx')
    ran.append('reopen')
    if not r['ok']:
        if reopen(post, 'docx')['ok']:
            return {'ok': False, 'why': 'the copy does not reopen', 'ran': ran, 'skipped': skipped}
        skipped.append({'check': 'reopen', 'reason': 'the agent\'s version does not reopen either'})
    soffice, why = soffice_path()
    if not soffice:
        skipped.append({'check': 'soffice-convert', 'reason': why})
    else:
        d = tempfile.mkdtemp(prefix='onionskin-chk-')
        try:
            copy = os.path.join(d, 'copy.docx')
            shutil.copyfile(out, copy)
            c = soffice_convert(soffice, copy, int(os.environ.get('ONIONSKIN_SOFFICE_TIMEOUT', '90')), 'odt')
            ran.append('soffice-convert')
            if not c['ok']:
                return {'ok': False, 'why': 'LibreOffice could not open the copy', 'ran': ran, 'skipped': skipped}
        finally:
            shutil.rmtree(d, ignore_errors=True)
    return {'ok': True, 'why': '', 'ran': ran, 'skipped': skipped}


def main(pre, post, fmt, mode=''):
    # mode '--no-soffice': everything but the LibreOffice conversion (reported as pending); '--soffice-only': just that conversion
    flags, ran, skipped = [], [], []
    if mode == '--soffice-only':
        run_soffice(pre, post, fmt, flags, ran, skipped)
        return {'flags': flags, 'ran': ran, 'skipped': skipped}
    za, zb = zipfile.ZipFile(pre), zipfile.ZipFile(post)
    flags += parts_diff(za, zb)
    ran.append('parts-diff')
    flags += multiset_diff(za, zb)
    ran.append('multiset-diff')
    flags += rels_check(zb, za)
    ran.append('rels-check')
    r_post = reopen(post, fmt)
    ran.append('reopen')
    if not r_post['ok']:
        before_ok = reopen(pre, fmt)['ok']
        flags.append(flag('reopen_failed', 'error' if before_ok else 'info', detail=r_post['error'], also_failed_before=not before_ok))
    if mode == '--no-soffice':
        soffice, why = soffice_path()
        skipped.append({'check': 'soffice-convert', 'reason': 'pending (runs in the background)', 'pending': True} if soffice else {'check': 'soffice-convert', 'reason': why})
    else:
        run_soffice(pre, post, fmt, flags, ran, skipped)
    return {'flags': flags, 'ran': ran, 'skipped': skipped}


def run_soffice(pre, post, fmt, flags, ran, skipped):
    soffice, why = soffice_path()
    if not soffice:
        skipped.append({'check': 'soffice-convert', 'reason': why})
    else:
        timeout = int(os.environ.get('ONIONSKIN_SOFFICE_TIMEOUT', '90'))
        ext = '.' + fmt
        d = tempfile.mkdtemp(prefix='onionskin-chk-')
        try:
            copy = os.path.join(d, 'after' + ext)
            shutil.copyfile(post, copy)
            r = soffice_convert(soffice, copy, timeout)
            ran.append('soffice-convert')
            if not r['ok']:
                shutil.copyfile(pre, os.path.join(d, 'before' + ext))
                before = soffice_convert(soffice, os.path.join(d, 'before' + ext), timeout)
                flags.append(flag('soffice_convert_failed', 'error' if before['ok'] else 'info', detail=r.get('error', ''), also_failed_before=not before['ok']))
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == '--redline':
        signal.signal(signal.SIGTERM, on_term)
        try:
            out = redline(*sys.argv[2:])
        except Exception as e:
            out = {'ok': False, 'why': f'{type(e).__name__}: {str(e)[:300]}', 'ran': [], 'skipped': []}
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(0)
    if len(sys.argv) not in (4, 5) or (len(sys.argv) == 5 and sys.argv[4] not in ('--no-soffice', '--soffice-only')):
        print(json.dumps({'error': 'usage: check.py PRE POST FORMAT [--no-soffice|--soffice-only]'}))
        sys.exit(1)
    signal.signal(signal.SIGTERM, on_term)
    try:
        out = main(*sys.argv[1:])
    except Exception as e:
        print(json.dumps({'error': f'{type(e).__name__}: {str(e)[:300]}'}))
        sys.exit(1)
    print(json.dumps(out, ensure_ascii=False))
