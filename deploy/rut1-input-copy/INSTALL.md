# RUT1 input-copy installation handoff

This package is inert in git. Ops-coord owns installation and enablement after
review. It must install the four unit files byte-for-byte, run each service with
`--check`, and verify the systemd calendar before enabling either timer.

The units run from the installed QRP tree at
`/srv/research-lane/research-queue/code/current`. Installation must refuse if
that path is missing or if it does not resolve to the exact reviewed QRP commit.

The runtime user must already have read-only access to the pinned Linux-to-HK
key paths and write access only below `/srv/research-lane/overseas`. Do not copy
keys, alter the HK gate, create a broader route, or enable a unit if `--check`
does not show only the frozen R-04/R-05/R-06/R-06-READ/R-16 forms.

Package B does not install, enable, deploy, or contact HK as part of acceptance.
