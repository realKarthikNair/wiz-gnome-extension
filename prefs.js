import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WizLightsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const bulbGroup = new Adw.PreferencesGroup({
            title: _('WiZ bulb'),
            description: _('Network address of your WiZ smart bulb. Find the IP in your router or in the WiZ app.'),
        });
        page.add(bulbGroup);

        const ipRow = new Adw.EntryRow({title: _('Bulb IP address')});
        settings.bind('bulb-ip', ipRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        bulbGroup.add(ipRow);

        const portRow = new Adw.SpinRow({
            title: _('UDP port'),
            subtitle: _('WiZ bulbs listen on 38899'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 65535,
                step_increment: 1,
                page_increment: 100,
            }),
        });
        settings.bind('bulb-port', portRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        bulbGroup.add(portRow);

        const panelGroup = new Adw.PreferencesGroup({title: _('Panel icon')});
        page.add(panelGroup);

        const toggleRow = new Adw.SwitchRow({
            title: _('Right-click toggles the light'),
            subtitle: _('Left-click always opens the menu'),
        });
        settings.bind('right-click-toggles-power', toggleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(toggleRow);
    }
}
