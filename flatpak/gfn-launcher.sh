#!/bin/sh
# Launcher for the Flatpak build.
#
# zypak-wrapper, from org.electronjs.Electron2.BaseApp, is what lets Chromium's
# own sandbox work inside Flatpak's: it intercepts the SUID-sandbox calls
# Chromium expects and redirects them at the Flatpak sandbox we are already in.
# Without it the app either refuses to start or has to be run with
# --no-sandbox, which turns off the renderer isolation this launcher relies on.
#
# --class is passed explicitly rather than left to be derived. It sets the
# window's WM_CLASS, which has to equal StartupWMClass in the .desktop file or
# the desktop cannot tie the running window to the entry — and the entry is
# where the icon lives, so a mismatch means a generic placeholder in the taskbar.
exec zypak-wrapper /app/gfn-launcher/gfn-launcher \
  --class=io.github.robertotucci.GfnLauncher \
  "$@"
