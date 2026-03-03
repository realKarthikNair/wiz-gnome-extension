import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WizLightsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('WiZ bulb'),
            description: _('Network address of your WiZ smart bulb. Find the IP in your router or WiZ app.'),
        });
        page.add(group);

        const ipRow = new Adw.EntryRow({
            title: _('Bulb IP address'),
            text: settings.get_string('bulb-ip'),
        });
        settings.bind('bulb-ip', ipRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(ipRow);

        const portRow = new Adw.SpinRow({
            title: _('UDP port'),
            subtitle: _('Default is 38899 for WiZ bulbs'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 65535,
                step_increment: 1,
                page_increment: 100,
            }),
        });
        portRow.set_value(settings.get_int('bulb-port'));
        portRow.connect('notify::value', () => {
            settings.set_int('bulb-port', portRow.get_value());
        });
        group.add(portRow);
    }
}
