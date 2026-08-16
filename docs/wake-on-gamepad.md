# Waking the PC with a gamepad

The launcher can put the machine to sleep (nav rail → Power → Sleep). Waking it
back up with the pad is a system setting the launcher **cannot** apply itself:
`/sys/bus/usb/devices/*/power/wakeup` is root-owned, and the launcher runs as
your user with no privilege escalation anywhere in it. This is one udev rule,
installed once.

## What has to be true

USB devices default to `disabled` for remote wakeup. Three things have to line
up:

1. The pad (or its wireless receiver) is **wired or on a USB dongle**. A
   Bluetooth pad almost never works — the host's Bluetooth radio is powered down
   in S3, and only a handful of USB Bluetooth adapters keep a wake path alive.
2. The device's own `power/wakeup` says `enabled`.
3. The USB controller is allowed to wake the machine. On most modern boards this
   is already true; on some it needs `XHC` enabling in `/proc/acpi/wakeup`, and
   on a few it needs "USB wake" or "Wake on USB from S3" turning on in the
   firmware setup.

## 1. Find the device

Plug the pad or its receiver in, then:

```bash
lsusb
```

Find the line for your pad and note the `ID vendor:product` pair — for example
`ID 045e:02ea Microsoft Corp. Xbox One S Controller`, where the vendor is `045e`
and the product is `02ea`.

Check what it currently reports:

```bash
for dev in /sys/bus/usb/devices/*/; do
  [ -f "$dev/idVendor" ] || continue
  printf '%s %s:%s wakeup=%s\n' \
    "$(basename "$dev")" \
    "$(cat "$dev/idVendor")" "$(cat "$dev/idProduct")" \
    "$(cat "$dev/power/wakeup" 2>/dev/null || echo n/a)"
done
```

A pad that cannot wake the machine shows `wakeup=disabled`.

## 2. Install the rule

Create `/etc/udev/rules.d/90-gamepad-wakeup.rules`, substituting your own
vendor and product ids:

```udev
# Let the gamepad wake the machine from suspend.
# `ATTR{power/wakeup}` is set on the USB *device*, not on the input node, so the
# match has to be SUBSYSTEM=="usb" with ATTR{idVendor}/ATTR{idProduct} — the
# input subsystem has no such attribute and the rule would silently never fire.
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="045e", ATTR{idProduct}=="02ea", ATTR{power/wakeup}="enabled"
```

Add one line per pad if there is more than one.

Reload and re-trigger without rebooting:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=usb --action=add
```

Re-run the loop from step 1: the device should now read `wakeup=enabled`.

## 3. If it still does not wake

Check that the USB controller itself is armed:

```bash
cat /proc/acpi/wakeup | grep -i xhc
```

`disabled` means the controller will not signal a wake event no matter what the
device says. Enable it for the current boot with:

```bash
echo XHC | sudo tee /proc/acpi/wakeup
```

That toggles, so run it once and check. To make it stick, add a systemd unit
that writes it at boot, or enable USB wake in the firmware setup instead — the
firmware option is the one that survives kernel upgrades.

## After it wakes

Waking the machine is not the same as getting back into the session. If the
desktop locks on suspend, the lock screen wants a password, and that is one of
the two places in this product a keyboard is unavoidable (the other is the GFN
sign-in page). On a TV that is used as an appliance, the usual answer is to turn
the screen lock off for that session in the desktop's own settings — the
launcher deliberately does not touch it, because a program that silently
disables your lock screen is not one you should trust.
