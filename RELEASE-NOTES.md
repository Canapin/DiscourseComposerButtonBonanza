# Release Notes

## Version 2.0.0

***Upgrading***
 - This version is functionally identical to version 1.0.0, but it now requires
   Discourse >= 3.5.0.beta9-dev, due to use of the `capabilities.isMobileDevice`
   predicate introduced in that release.

**Changes**
 - Improved `README.md` a bit.

**Fixes**
 - Fixes a deprecation warning, by replacing instances of `site.desktopView`,
   which was deprecated for use in initializer contexts in Discourse version
   3.5.0.beta9-dev.  Instead, `capabilities.isMobileDevice` is used now.
---

## Version 1.0.0

**Initial version**

---
