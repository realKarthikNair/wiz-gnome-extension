# WiZ Lights GNOME Extension

A GNOME Shell extension to control a Philips WiZ smart bulb from the top panel.

It adds a bulb icon to the panel. Left-click opens a menu with a power switch,
brightness and white-balance sliders, quick presets and a custom colour entry.
Right-click toggles the bulb on or off (can be turned off in the settings).

All communication with the bulb is done by the bundled `wiz.sh` script over
UDP on your local network. The extension only talks to the bulb when you open
the menu or change something; there is no background polling.

Supports GNOME Shell 45 to 50.

## Requirements

- GNOME Shell 45 or later
- A WiZ bulb on the same local network, with a known IP address
- bash 4 or later (uses bash's built-in UDP sockets; falls back to `nc` if
  those are unavailable)
- `zenity` (optional, for the graphical colour picker)

## Install

### From a release zip (recommended)

Download the latest `wiz-lights-<version>.zip` (for example
`wiz-lights-2.0.1.zip`) from the
[Releases page](https://github.com/realkarthiknair/wiz-gnome-extension/releases)
and install it:

```bash
gnome-extensions install --force ~/Downloads/wiz-lights-2.0.1.zip
```

Log out and back in, then enable it in the Extensions app or with:

```bash
gnome-extensions enable wiz-lights@local
```

### From source

```bash
git clone https://github.com/realkarthiknair/wiz-gnome-extension.git
cp -r wiz-gnome-extension ~/.local/share/gnome-shell/extensions/wiz-lights@local
```

Log out and back in, then enable the extension as above.

### Building the release zip

`gnome-extensions pack` only bundles the standard files by default, so the
script and the icon have to be listed explicitly:

```bash
gnome-extensions pack --force \
    --extra-source=wiz.sh --extra-source=icons --extra-source=README.md \
    --out-dir=/tmp .
mv /tmp/wiz-lights@local.shell-extension.zip /tmp/wiz-lights-2.0.1.zip
```

`pack` always names the file after the UUID, hence the rename to the versioned
name used on the Releases page. The zip has the schema compiled and `wiz.sh`
kept executable. Remember to bump `version-name` in `metadata.json` first.

## Configuration

Open the settings from the **Settings** item at the bottom of the menu, from the
Extensions app, or with:

```bash
gnome-extensions prefs wiz-lights@local
```

| Setting | Description | Default |
|---------|-------------|---------|
| Bulb IP address | IPv4 address of your WiZ bulb | `192.168.1.11` |
| UDP port | Port the bulb listens on | `38899` |
| Right-click toggles the light | Right-click on the panel icon turns the bulb on/off | on |

You can find the bulb IP in your router's admin page or in the WiZ app.

## Usage

Click the bulb icon in the top panel:

- **Power** switch: turn the bulb on or off
- **Brightness**: slider (10-100 %) and **25% / 50% / 75% / 100%** buttons
- **White balance**: slider (2200-6500 K)
- **Presets**: **Warmest** (2200 K), **Warm** (2700 K), **Day** (4500 K),
  **Cool** (6500 K) and **Night** (2200 K at 10 % brightness). Leaving Night
  for any other preset restores 100 % brightness.
- **Custom colour**: type `#RRGGBB` and press Enter, or use the picker button
- **Settings**: opens the extension preferences

When the menu opens, the current bulb state is read and the switch, sliders and
values are updated to match. Every change is read back from the bulb after it
is sent; if the bulb does not confirm it, the command is retried once. If it
still fails, a notification appears with an **Open Settings** button so you can
check the bulb IP.

## The script

`wiz.sh` contains all of the bulb logic and can be used on its own:

```
wiz.sh [--ip IP] [--port PORT] COMMAND [OPTIONS]

  --on                    Turn the bulb on
  --off                   Turn the bulb off
  --toggle                Turn the bulb off if it is on, otherwise on
  --brightness N          Set brightness 10-100 % (implies on)
  --temp K                Set white balance 2200-6500 K (implies on)
  --rgb R G B             Set an RGB colour, 0-255 each (implies on)
  --hex #RRGGBB           Same as --rgb, from a hex colour
  --preset NAME           warmest | warm | day | cool | night
  --pick                  Choose a colour with zenity, then apply it
  --status                Print the current bulb state (read only)
```

`--brightness` can be combined with `--temp`, `--rgb`, `--hex` or `--preset`.
Examples:

```bash
./wiz.sh --ip 192.168.1.50 --preset warm
./wiz.sh --ip 192.168.1.50 --temp 4000 --brightness 70
./wiz.sh --ip 192.168.1.50 --hex '#ff8800'
./wiz.sh --ip 192.168.1.50 --status
```

On success the verified bulb state is printed as JSON, for example:

```json
{"mac":"9877d5170d88","rssi":-51,"state":true,"sceneId":0,"temp":4500,"dimming":100}
```

Exit codes: `0` ok, `1` invalid arguments, `2` colour picker cancelled,
`3` bulb unreachable or the change was not confirmed (details on stderr).

The reply timeout can be tuned with the `WIZ_TIMEOUT` environment variable
(seconds, default `1`).

## Layout

| File | Purpose |
|------|---------|
| `wiz.sh` | All bulb logic: UDP protocol, presets, verification, colour parsing, colour picker |
| `extension.js` | Panel menu UI; runs `wiz.sh` and displays the JSON it returns |
| `prefs.js` | Preferences window |
| `stylesheet.css` | Menu styling (loaded automatically by GNOME Shell) |
| `icons/wiz-bulb-symbolic.svg` | Panel icon (original drawing) |
| `schemas/` | GSettings schema |
