// WiZ Lights - GNOME Shell extension
//
// This file only builds the panel menu and renders bulb state. Every bulb
// operation (UDP protocol, presets, verification, colour parsing, colour
// picker) lives in wiz.sh; the menu just runs it and displays the JSON it
// prints. The bulb is only queried when the menu is opened - never in the
// background.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

/** Ranges mirrored from wiz.sh, used only to map slider positions. */
const DIM_MIN = 10;
const DIM_MAX = 100;
const TEMP_MIN = 2200;
const TEMP_MAX = 6500;

/** Delay before a slider position is sent, so a drag results in one command. */
const SLIDER_SETTLE_MS = 300;

/** wiz.sh exit codes: colour picker cancelled / bulb unreachable or unconfirmed. */
const EXIT_CANCELLED = 2;
const EXIT_BULB_FAILED = 3;

const BRIGHTNESS_PRESETS = [25, 50, 75, 100];

/** Preset ids understood by `wiz.sh --preset`. */
const COLOR_PRESETS = ['warmest', 'warm', 'day', 'cool', 'night'];

/** GNOME 49+ opens panel menus with click gestures; older shells use events. */
const USE_GESTURES = Clutter.ClickGesture !== undefined;

/** Raised when wiz.sh gave up on the bulb (no reply or change not confirmed). */
class BulbError extends Error {}

const toFraction = (value, min, max) =>
    Math.max(0, Math.min(1, (value - min) / (max - min)));
const fromFraction = (fraction, min, max) =>
    Math.round(min + fraction * (max - min));
const toHex = (r, g, b) =>
    `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;

const WizIndicator = GObject.registerClass(
class WizIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, extension.metadata.name, false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._script = GLib.build_filenamev([extension.path, 'wiz.sh']);

        this._cancellable = new Gio.Cancellable();
        this._busy = false;
        this._queue = new Map();     // kind -> pending job (latest per kind)
        this._timeouts = new Map();  // kind -> GLib source id
        this._dragging = new Set();  // slider kinds currently being dragged
        this._syncing = false;       // true while widgets mirror bulb state

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(
                GLib.build_filenamev([extension.path, 'icons', 'wiz-bulb-symbolic.svg'])),
            style_class: 'system-status-icon',
        }));

        this._buildMenu();

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._run('status', ['--status']);
        });

        if (USE_GESTURES) {
            // Keep the menu's own click gesture away from the secondary button
            // while that button toggles the light.
            this._clickGesture?.connect('may-recognize',
                () => !this._isPowerButton(this._clickGesture.get_button()));

            const rightClick = new Clutter.ClickGesture({
                required_button: Clutter.BUTTON_SECONDARY,
                recognize_on_press: true,
            });
            rightClick.connect('may-recognize', () => this._rightClickTogglesPower());
            rightClick.connect('recognize', () => this._togglePower());
            this.add_action(rightClick);
        }
    }

    /** GNOME 45-48: intercept the secondary button before the menu opens. */
    vfunc_event(event) {
        if (!USE_GESTURES &&
            event.type() === Clutter.EventType.BUTTON_PRESS &&
            this._isPowerButton(event.get_button())) {
            this._togglePower();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    _rightClickTogglesPower() {
        return this._settings.get_boolean('right-click-toggles-power');
    }

    _isPowerButton(button) {
        return button === Clutter.BUTTON_SECONDARY && this._rightClickTogglesPower();
    }

    _togglePower() {
        this._run('power', ['--toggle'],
            state => state.state ? _('Light turned on') : _('Light turned off'));
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('wiz-menu');

        // Power
        this._powerItem = new PopupMenu.PopupSwitchMenuItem(_('Power'), false);
        this._powerItem.connect('toggled', (_item, state) => {
            if (this._syncing)
                return;
            this._run('power', [state ? '--on' : '--off'],
                state ? _('Light turned on') : _('Light turned off'));
        });
        this.menu.addMenuItem(this._powerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Brightness
        this._brightnessValue = this._addHeader(_('Brightness'));
        this._brightnessSlider = this._addSlider({
            kind: 'brightness',
            iconName: 'display-brightness-symbolic',
            name: _('Brightness'),
            format: value => `${fromFraction(value, DIM_MIN, DIM_MAX)}%`,
            valueLabel: this._brightnessValue,
            job: value => this._brightnessJob(fromFraction(value, DIM_MIN, DIM_MAX)),
        });
        this._addButtonRow(BRIGHTNESS_PRESETS.map(percent => ({
            label: `${percent}%`,
            onClick: () => this._run('brightness', ...this._brightnessJob(percent)),
        })));

        // White balance
        this._tempValue = this._addHeader(_('White balance'));
        this._tempSlider = this._addSlider({
            kind: 'temp',
            iconName: 'night-light-symbolic',
            name: _('White balance'),
            format: value => `${fromFraction(value, TEMP_MIN, TEMP_MAX)} K`,
            valueLabel: this._tempValue,
            job: value => {
                const kelvin = fromFraction(value, TEMP_MIN, TEMP_MAX);
                return [['--temp', String(kelvin)], `${_('White balance set to')} ${kelvin} K`];
            },
        });

        // Presets
        const presetLabels = {
            warmest: _('Warmest'),
            warm: _('Warm'),
            day: _('Day'),
            cool: _('Cool'),
            night: _('Night'),
        };
        this._addButtonRow(COLOR_PRESETS.map(id => ({
            label: presetLabels[id],
            onClick: () => this._run('preset', ['--preset', id],
                `${_('Preset applied:')} ${presetLabels[id]}`),
        })));

        // Custom colour
        this._addColorRow();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Settings
        const settingsItem = new PopupMenu.PopupImageMenuItem(
            _('Settings'), 'preferences-system-symbolic');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _brightnessJob(percent) {
        return [['--brightness', String(percent)], `${_('Brightness set to')} ${percent}%`];
    }

    /** Non-activatable menu row wrapping a custom widget. */
    _addRow(child, styleClass) {
        const item = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            hover: false,
            can_focus: false,
            style_class: styleClass,
        });
        item.add_child(child);
        this.menu.addMenuItem(item);
        return item;
    }

    /** Section header with a value label on the right; returns the value label. */
    _addHeader(title) {
        const box = new St.BoxLayout({x_expand: true});
        box.add_child(new St.Label({
            text: title,
            style_class: 'wiz-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const value = new St.Label({
            style_class: 'wiz-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(value);
        this._addRow(box, 'wiz-header-row');
        return value;
    }

    /** Icon + slider row. Sends a command once the slider settles. */
    _addSlider({kind, iconName, name, format, valueLabel, job}) {
        const box = new St.BoxLayout({x_expand: true, style_class: 'wiz-slider-box'});
        box.add_child(new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const slider = new Slider(0);
        slider.accessible_name = name;
        box.add_child(slider);

        const schedule = () => this._schedule(kind, () => job(slider.value));

        slider.connect('drag-begin', () => this._dragging.add(kind));
        slider.connect('drag-end', () => {
            this._dragging.delete(kind);
            schedule();
        });
        slider.connect('notify::value', () => {
            valueLabel.text = format(slider.value);
            if (!this._syncing && !this._dragging.has(kind))
                schedule();
        });
        valueLabel.text = format(slider.value);

        this._addRow(box, 'wiz-slider-row');
        return slider;
    }

    /** Row of equally sized buttons. */
    _addButtonRow(buttons) {
        const row = new St.Widget({
            layout_manager: new Clutter.BoxLayout({homogeneous: true, spacing: 6}),
            x_expand: true,
        });
        for (const {label, onClick} of buttons) {
            const button = new St.Button({
                label,
                style_class: 'button wiz-button',
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', onClick);
            row.add_child(button);
        }
        this._addRow(row, 'wiz-button-row');
    }

    /** Hex entry plus a colour picker button. */
    _addColorRow() {
        const box = new St.BoxLayout({x_expand: true, style_class: 'wiz-color-box'});

        this._hexEntry = new St.Entry({
            hint_text: _('#RRGGBB'),
            style_class: 'wiz-hex-entry',
            can_focus: true,
            x_expand: true,
        });
        this._hexEntry.clutter_text.connect('activate', () => {
            const text = this._hexEntry.text.trim();
            if (text)
                this._run('color', ['--hex', text], _('Colour set'));
        });
        box.add_child(this._hexEntry);

        const pickButton = new St.Button({
            child: new St.Icon({icon_name: 'color-select-symbolic'}),
            style_class: 'icon-button',
            accessible_name: _('Pick a colour'),
            can_focus: true,
        });
        pickButton.connect('clicked', () => this._run('color', ['--pick'], _('Colour set')));
        box.add_child(pickButton);

        this._addRow(box, 'wiz-color-row');
    }

    /** Debounce slider changes so one command is sent per adjustment. */
    _schedule(kind, makeJob) {
        this._clearTimeout(kind);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDER_SETTLE_MS, () => {
            this._timeouts.delete(kind);
            this._run(kind, ...makeJob());
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.set(kind, id);
    }

    _clearTimeout(kind) {
        const id = this._timeouts.get(kind);
        if (id) {
            GLib.Source.remove(id);
            this._timeouts.delete(kind);
        }
    }

    /**
     * Run wiz.sh with the given arguments. Commands run one at a time; while
     * one is in flight the newest request of each kind is kept and run next.
     *
     * @param {string} kind - queue slot ('status', 'power', 'brightness', ...)
     * @param {string[]} args - wiz.sh arguments
     * @param {string|Function} [message] - notification shown once the bulb
     *     confirmed; a function receives the verified state
     */
    _run(kind, args, message = null) {
        if (this._busy) {
            this._queue.delete(kind);
            this._queue.set(kind, {args, message});
            return;
        }

        this._busy = true;
        this._exec(args).then(state => {
            if (this._cancellable.is_cancelled() || !state)
                return;
            this._applyState(state);
            const text = typeof message === 'function' ? message(state) : message;
            if (text)
                Main.notify(this._extension.metadata.name, text);
        }).catch(error => {
            if (this._cancellable.is_cancelled())
                return;
            if (kind === 'status')
                console.debug(`${this._extension.metadata.name}: ${error.message}`);
            else if (error instanceof BulbError)
                this._notifyBulbFailure(error.message);
            else
                Main.notify(this._extension.metadata.name, error.message);
        }).finally(() => {
            this._busy = false;
            if (this._cancellable.is_cancelled())
                return;
            const next = this._queue.entries().next().value;
            if (next) {
                const [nextKind, job] = next;
                this._queue.delete(nextKind);
                this._run(nextKind, job.args, job.message);
            }
        });
    }

    /** Spawn wiz.sh and return the parsed JSON state it prints (or null). */
    async _exec(args) {
        const ip = this._settings.get_string('bulb-ip').trim();
        if (!ip)
            throw new Error(_('Set the bulb IP address in the extension settings.'));
        const port = this._settings.get_int('bulb-port');

        const proc = Gio.Subprocess.new(
            ['/bin/bash', this._script, '--ip', ip, '--port', String(port), ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const cancelId = this._cancellable.connect(() => proc.send_signal(15));

        try {
            const [stdout, stderr] =
                await proc.communicate_utf8_async(null, this._cancellable);

            if (proc.get_if_exited() && proc.get_exit_status() === EXIT_CANCELLED)
                return null;
            if (!proc.get_successful()) {
                const detail = stderr.trim().replace(/^Error:\s*/, '');
                if (proc.get_if_exited() && proc.get_exit_status() === EXIT_BULB_FAILED)
                    throw new BulbError(detail || _('The bulb did not respond.'));
                throw new Error(detail || _('wiz.sh failed.'));
            }

            const output = stdout.trim();
            if (!output)
                return null;
            try {
                return JSON.parse(output);
            } catch {
                throw new Error(_('Unexpected output from wiz.sh.'));
            }
        } finally {
            this._cancellable.disconnect(cancelId);
        }
    }

    /**
     * Shown when the bulb did not confirm a change even after the retry:
     * a persistent notification with a button to reconfigure the bulb IP.
     */
    _notifyBulbFailure(detail) {
        this._errorNotification?.destroy();

        const ip = this._settings.get_string('bulb-ip').trim();
        const title = `${this._extension.metadata.name}: ${_('bulb not reachable')}`;
        const body = `${detail}\n${_('Check that the bulb IP address (%s) is correct.').format(ip)}`;

        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            iconName: 'dialog-warning-symbolic',
            urgency: MessageTray.Urgency.HIGH,
            isTransient: false,
        });
        notification.addAction(_('Open Settings'),
            () => this._extension.openPreferences());
        notification.connect('destroy', () => {
            if (this._errorNotification === notification)
                this._errorNotification = null;
        });
        this._errorNotification = notification;
        source.addNotification(notification);
    }

    /** Mirror the verified bulb state in the menu without sending commands. */
    _applyState(state) {
        this._syncing = true;
        try {
            if (typeof state.state === 'boolean')
                this._powerItem.setToggleState(state.state);

            if (Number.isFinite(state.dimming))
                this._brightnessSlider.value = toFraction(state.dimming, DIM_MIN, DIM_MAX);

            if (Number.isFinite(state.temp))
                this._tempSlider.value = toFraction(state.temp, TEMP_MIN, TEMP_MAX);

            if ([state.r, state.g, state.b].every(Number.isFinite))
                this._hexEntry.text = toHex(state.r, state.g, state.b);
        } finally {
            this._syncing = false;
        }
    }

    _onDestroy() {
        this._cancellable.cancel();
        this._errorNotification?.destroy();
        this._errorNotification = null;
        for (const id of this._timeouts.values())
            GLib.Source.remove(id);
        this._timeouts.clear();
        this._queue.clear();
        super._onDestroy();
    }
});

export default class WizLightsExtension extends Extension {
    enable() {
        this._indicator = new WizIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
