# python3 pty-run.py <answer|EOF|-> [--then <line>] cmd args...
# Runs cmd on a pseudo-terminal (stdin and stdout are terminals, as when a person types it), prints everything it wrote
# with \r removed, and types <answer> + Enter if a [Y/n] question shows (EOF: Ctrl-D; -: never answers). `open` asks no question any more;
# the answer is kept so a test can prove nothing waits for one.
# --then: types <line> + Enter once the output shows AGENT-READY (a fake agent reading the keyboard). Exits with cmd's code.
import os, pty, sys, time

answer, cmd, then = sys.argv[1], sys.argv[2:], None
if cmd[0] == "--then":
    then, cmd = cmd[1], cmd[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
out, sent, deadline = b"", False, time.time() + 90
while time.time() < deadline:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not sent and answer != "-" and b"[Y/n]" in out:
        sent = True
        os.write(fd, b"\x04" if answer == "EOF" else answer.encode() + b"\n")
    if then is not None and b"AGENT-READY" in out:
        os.write(fd, then.encode() + b"\n")
        then = None
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf8", "replace").replace("\r", ""))
sys.exit(os.waitstatus_to_exitcode(status))
