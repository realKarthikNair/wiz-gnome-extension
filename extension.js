import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export default class WizLightsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._scriptPath = this.metadata.path + '/toggle-lights.sh';

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        const icon = new St.Icon({
            icon_name: 'display-brightness-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);

        this._indicator.menu.addAction(_('Turn On'), () => this._runScript('--on'));
        this._indicator.menu.addAction(_('Turn Off'), () => this._runScript('--off'));

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _runScript(action) {
        const ip = this._settings.get_string('bulb-ip').trim();
        if (!ip) {
            Main.notify(this.metadata.name, _('Set bulb IP in extension preferences.'), 'dialog-error-symbolic');
            return;
        }
        const argv = ['/bin/bash', this._scriptPath, action, '--ip', ip];
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.wait_async(null, (proc, res) => {
                try {
                    const ok = proc.wait_finish(res);
                    const success = ok && proc.get_exit_status() === 0;
                    Main.notify(
                        this.metadata.name,
                        success
                            ? (action === '--on' ? _('Light turned on') : _('Light turned off'))
                            : _('Failed. Check bulb IP and network.'),
                        success ? null : 'dialog-error-symbolic'
                    );
                } catch (e) {
                    Main.notify(this.metadata.name, _('Failed to run script.'), 'dialog-error-symbolic');
                }
            });
        } catch (e) {
            Main.notify(this.metadata.name, _('Failed to run script.'), 'dialog-error-symbolic');
        }
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}
