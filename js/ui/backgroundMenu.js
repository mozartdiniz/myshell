import Clutter from 'gi://Clutter';

import * as Main from './main.js';

/**
 * Right-click or long press on the desktop opens the root menu (see
 * dock/rootMenu.js), and middle-click the window list, as in WindowMaker.
 *
 * @param {Meta.BackgroundActor} actor
 * @param {import('./layout.js').LayoutManager} _layoutManager
 */
export function addBackgroundMenu(actor, _layoutManager) {
    actor.reactive = true;

    const longPressGesture = new Clutter.LongPressGesture({
        required_button: Clutter.BUTTON_PRIMARY,
    });
    longPressGesture.connect('recognize', () => {
        const {x, y} = longPressGesture.get_coords_abs();
        Main.rootMenu?.popup(x, y);
    });
    actor.add_action(longPressGesture);

    const clickGesture = new Clutter.ClickGesture({
        required_button: Clutter.BUTTON_SECONDARY,
        recognize_on_press: true,
    });
    clickGesture.connect('recognize', () => {
        const {x, y} = clickGesture.get_coords_abs();
        Main.rootMenu?.popup(x, y);
    });
    actor.add_action(clickGesture);

    const middleClickGesture = new Clutter.ClickGesture({
        required_button: Clutter.BUTTON_MIDDLE,
        recognize_on_press: true,
    });
    middleClickGesture.connect('recognize', () => {
        const {x, y} = middleClickGesture.get_coords_abs();
        Main.rootMenu?.popupWindowList(x, y);
    });
    actor.add_action(middleClickGesture);
}
