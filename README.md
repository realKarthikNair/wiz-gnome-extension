# WiZ Lights GNOME Extension

Turn Philips WiZ smart bulbs on or off from the GNOME Shell panel, using the bundled `toggle-lights.sh` script under the hood.


## Install

1. Make sure you are in the `wiz-gnome-extension` directory

2. Now you can either use the `gnome-extensions` CLI to install the extension zip file or you can manually install the extension folder to the `~/.local/share/gnome-shell/extensions` directory   

3. If you are using the `gnome-extensions` CLI, you can run the following command:

```bash
gnome-extensions install wiz-gnome-extension.zip
```

4. If you are manually installing the extension folder

```bash
cp -r wiz-gnome-extension ~/.local/share/gnome-shell/extensions/wiz-lights@local
```

5. Now you can enable the extension by running the following command:

```bash
gnome-extensions enable wiz-lights@local
```

6. If it is not working, restart the session by logging out and logging in again. Repeat step 5 after logging in again.