# Downstream Documentation

This directory records the boundaries and reproducible verification gates for the Code OSS
downstream.

- [Baseline](baseline.md) records the pinned upstream release, branch policy, build environment,
  and runnable validation commands.
- [SCM inventory](scm-inventory.md) identifies the upstream Source Control and built-in Git seams
  that must remain compatible through downstream upgrades.
- [Canonical configuration](canonical-configuration.md) defines the portable global and
  repository-local Git contracts and their machine-state boundary.

Product behavior belongs in dedicated downstream services and contributions. Upstream source should
remain unchanged unless a narrower composition seam is not viable and the exception is documented
here.
