# WiZ Lights GNOME Extension

A GNOME Shell extension to turn Philips WiZ smart bulbs on or off from the top panel.

Adds a brightness icon to the panel with a dropdown menu: **Turn On** / **Turn Off**. Sends UDP commands to the bulb via the bundled `toggle-lights.sh` script. Bulb IP is configurable in extension preferences.

Supports GNOME Shell 45–49.

## Requirements

- GNOME Shell 45 or later
- WiZ smart bulb on the same local network
- `netcat` (`nc`) installed (used by the script for UDP)

## Install

### From releases

1. Download the latest `.zip` from the [Releases](https://github.com/realkarthiknair/wiz-gnome-extension/releases) page.

2. Install it:

```bash
gnome-extensions install ~/Downloads/wiz-gnome-extension-<version>.zip
```

3. Log out and log back in.

4. Enable the extension in the GNOME Extensions app, or:

```bash
gnome-extensions enable wiz-lights@local
```

### From source

1. Clone and copy:

```bash
git clone https://github.com/realkarthiknair/wiz-gnome-extension.git
cp -r wiz-gnome-extension ~/.local/share/gnome-shell/extensions/wiz-lights@local
```

2. Log out and log back in.

3. Enable the extension in the GNOME Extensions app, or:

```bash
gnome-extensions enable wiz-lights@local
```

## Configuration

Open extension preferences from the GNOME Extensions app (gear icon on WiZ Lights) or:

```bash
gnome-extensions prefs wiz-lights@local
```

| Setting | Description | Default |
|---------|-------------|---------|
| Bulb IP address | IPv4 address of your WiZ bulb | `192.168.1.11` |
| UDP port | Port the bulb listens on | `38899` |

You can find the bulb IP in your router's admin page or the WiZ app.

## Usage

Click the brightness icon in the top panel and choose **Turn On** or **Turn Off**. A desktop notification confirms the result.
