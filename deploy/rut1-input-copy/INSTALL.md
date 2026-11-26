# RUT1 input-copy installation handoff

This package is inert in git. Ops-coord owns installation and enablement after
review. It must install the four unit files byte-for-byte, run each service with
`--check`, and verify the systemd calendar before enabling either timer.

The checked-in units are templates. `@QRP_REVIEWED_SHA@` is replaced exactly
once at installation with the accepted 40-lower-hex commit. It must never be
replaced with a branch, tag, `current`, or another symlink. The rendered units
therefore run from the immutable tree
`/srv/research-lane/research-queue/code/<exact reviewed QRP commit>`.

Before rendering, installation must refuse unless all of these checks pass:

- the code root exists as a real directory, no path component or tree entry is
  a symlink, and its basename is the exact reviewed QRP commit;
- every tree entry is covered by the independently approved tree manifest and
  `sha256sum -c` reports no missing or extra entry;
- the complete tree has the reviewed owner and mode: no file or directory is
  group/world writable, and the manifest records the intended executable bits;
- the release record binds the exact commit, tree-manifest SHA-256, and the
  source PR acceptance. Any mismatch refuses installation.

Render both service templates into a new private staging directory. Reject a
rendered file if it still contains `@QRP_REVIEWED_SHA@` or `/code/current`.
Record each rendered unit's SHA-256, install those exact bytes, read them back,
and compare the SHA-256 again before `daemon-reload`. Changing `current` after
this point must not change either unit's `WorkingDirectory` or `PYTHONPATH`.

The runtime user must already have read-only access to the pinned Linux-to-HK
key paths and write access only below `/srv/research-lane/overseas`. Do not copy
keys, alter the HK gate, create a broader route, or enable a unit if `--check`
does not show only the frozen R-04/R-05/R-06/R-06-READ/R-16 forms.

Package B does not install, enable, deploy, or contact HK as part of acceptance.
