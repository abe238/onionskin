# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub private vulnerability reporting on this repository: open the **Security** tab, choose **Report a vulnerability**, and describe what you found. That keeps the report between you and the maintainer until it is fixed.

Helpful details: the Onionskin version (`onionskin --version`), the output of `onionskin doctor`, the steps to reproduce, and what you think the impact is. Please use a synthetic document, not one that holds real personal or company data.

## What to expect

This is a one-person project. You will get an acknowledgment, a fix or a clear answer on whether it is in scope, and credit in the release notes if you want it. There is no bounty.

## Scope

Onionskin runs a local server on `127.0.0.1`, serves a browser editor, and talks to a coding agent over a private socket on your own computer. Reports about that surface are in scope: the local server, the launch link and cookie, how documents are opened and written, and what is passed to the agent.

A problem in a third-party project that Onionskin builds on should also be reported to that project.

## Supported versions

Only the latest release gets fixes.
