//
// This file is part of ComposerButtonBonanza.
//
// Copyright 2025 Matt Marjanovic
//
// ComposerButtonBonanza is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License as published
// by the Free Software Foundation; either version 3 of the License, or any
// later version.
//
// ComposerButtonBonanza is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
// Public License for more details.
//
// You should have received a copy of the GNU General Public License along
// with ComposerButtonBonanza.  If not, see <https://www.gnu.org/licenses/>.
//

import { apiInitializer } from "discourse/lib/api";


// A (hopefully) unique-to-this-component key to use in various identifiers,
// to avoid clashes/conflicts with other theme components/etc.
// Also used in console error messages as a hint as to who to blame.
//
// NB:  This must match corresponding code in scss/_selectors.scss.
//
const CBBKEY = "ComposerButtonBonanza";

// Construct the identifier for a button, e.g., used as a class name.
//
// NB:  This must match corresponding code in scss/_selectors.scss.
//
function makeButtonIdentifier(buttonName) {
    return `${CBBKEY}-btn-${buttonName}`;
}


// These are populated via our ApiInitializer (when we actually get to work).
let BUTTONS;
let TRANSLATIONS;
let TOGGLE_GROUPS;


// Enumeration of the types of button functions we support
const Action = Object.freeze({
    insert: "insert",
    surround: "surround",
    list: "list",
    toggleGroup: "toggleGroup",
});


// Enumeration for the categories of how/where a button can be created
const Place = Object.freeze({
    TOOLBAR: 1,  // directly in the toolbar
    GEARMENU: 2  // hidden in the "⚙️" popup menu
});


// Define the "SECTION" keywords used in the 'layout' setting.
const SECTIONS = Object.freeze({
    STYLES: [Place.TOOLBAR, "fontStyles"],
    INSERTIONS: [Place.TOOLBAR, "insertions"],
    EXTRAS: [Place.TOOLBAR, "extras"],
    GEARMENU: [Place.GEARMENU,],
});


// Override the defaultValue for a button's parameter, if a translation
// (for the current locale) has been specified in our 'translations' settings.
function applyTranslation(defaultValue, buttonName, paramName) {
    if (!TRANSLATIONS) { return defaultValue; }
    const key = `${buttonName}.${paramName}`;
    const translation = TRANSLATIONS.find((e) => e.key === key)?.value;
    return translation ?? defaultValue;
}


// Set a key/value pair, for the specified button, in i18nProperties.
//
// Returns the property's key.  If value is falsy, set no key and return null.
//
function setI18nProperty(buttonName, propName, propValue, i18nProperties) {
    if (!propValue) { return null; }
    i18nProperties[buttonName] ||= {};  // ensure path exists
    i18nProperties[buttonName][propName] = propValue;
    return `${CBBKEY}.${buttonName}.${propName}`;
}


// Tweak a selection to remove any leading whitespace, by shifting the
// start position.  (No characters are lost, but the input selection is
// mutated.)
//
// We need this to emulate the "trimLeading" option for gear-menu popup
// buttons, which do not have that option.
function trimLeading(selection) {
    // (Looping to UTF-16 code units, and not complete Unicode code points,
    // but we are just checking for whitespace, so... it's ok?  ¯\_(ツ)_/¯ )
    let freshStart = 0;
    while ((freshStart < selection.value.length) &&
           /\s/.test(selection.value.charAt(freshStart))) {
        freshStart++;
    }
    if (freshStart > 0) {
        selection.start += freshStart;
        selection.value = selection.value.substring(freshStart);
    }
}


// Create an 'insert' action callback.
//
function makeInsertAction(buttonName, text) {
    return (toolbarEvent) => {
        toolbarEvent.addText(text, {});
    };
}


// Create a 'surround' action callback.
//
function makeSurroundAction(buttonName, head, tail, exampleText, lineMode,
                           i18nProperties) {
    const exampleTextKey = setI18nProperty(
        buttonName, "exampleText", exampleText, i18nProperties);
    return (toolbarEvent) => {
        toolbarEvent.applySurround(head, tail, exampleTextKey,
                                   { multiline: (lineMode === "multiline"),
                                     useBlockMode: (lineMode === "block"),
                                   });
    };
}


// Create a 'list' action callback.
//
function makeListAction(buttonName, head, exampleText, lineMode,
                        i18nProperties) {
    const exampleTextKey = setI18nProperty(
        buttonName, "exampleText", exampleText, i18nProperties);
    return (toolbarEvent) => {
        toolbarEvent.applyList(head, exampleTextKey,
                               { multiline: (lineMode === "multiline"),
                                 useBlockMode: (lineMode === "block"),
                               });
    };
}


// Create a 'toggleGroup' action callback.
//
function makeToggleAction(buttonName, groupName, startHidden) {
    if (! TOGGLE_GROUPS[groupName]) {
        throw new Error(
            `No buttons are assigned to toggle-group '${groupName}' for button '${buttonName}'.`);
    }

    let isHidden = !!startHidden;

    // We programmatically construct a stylesheet that will set 'display: none'
    // for all the buttons in the group.  Then, (un)hiding is a matter of
    // (dis)enabling the stylesheet, and it takes effect whether or not the
    // buttons exist yet (e.g., the pop-up buttons are not constructed until
    // the pop-up menu is shown).
    const stylesheet = new CSSStyleSheet({ disabled: !isHidden });

    for (const spec of TOGGLE_GROUPS[groupName]) {
        const identifier = makeButtonIdentifier(spec.name);
        stylesheet.insertRule(
            `.${identifier} { display: none !important; }`);
        stylesheet.insertRule(
            `[data-name="${identifier}"] { display: none !important; }`);
    }

    document.adoptedStyleSheets.push(stylesheet);

    // Now, the actual event handler can just flip the bits.
    return (toolbarEvent) => {
        isHidden = !isHidden;
        stylesheet.disabled = !isHidden;
    }
}


// Construct the action (toolbar event handler) for a button.
//
function makeAction(buttonName, definition, i18nProperties) {
    switch (definition.action) {
    case Action.insert:
        return makeInsertAction(
            buttonName,
            applyTranslation(definition.prefix, buttonName, "prefix"),
        );
    case Action.surround:
        return makeSurroundAction(
            buttonName,
            applyTranslation(definition.prefix, buttonName, "prefix"),
            applyTranslation(definition.suffix, buttonName, "suffix"),
            applyTranslation(definition.exampleText, buttonName, "exampleText"),
            definition.lineMode,
            i18nProperties);
    case Action.list:
        return makeListAction(
            buttonName,
            applyTranslation(definition.prefix, buttonName, "prefix"),
            applyTranslation(definition.exampleText, buttonName, "exampleText"),
            definition.lineMode,
            i18nProperties);
    case Action.toggleGroup:
        return makeToggleAction(
            buttonName,
            applyTranslation(definition.groupName, buttonName, "groupName"),
            applyTranslation(definition.startHidden, buttonName, "startHidden"),
            i18nProperties);
    default:
        throw new Error(
            `Unknown action for button ${buttonName}:  ${definition.action}`);
    }
}


// Construct the button options/parameters that are common to both toolbar
// buttons and popup menu buttons.
//
function makeCommonButtonOptions(buttonSpec, i18nProperties) {
    const buttonName = buttonSpec.name;
    const definition = BUTTONS[buttonName];
    const titleKey = setI18nProperty(
        buttonName, "title",
        applyTranslation(definition.title, buttonName, "title"),
        i18nProperties);
    const action = makeAction(buttonName, definition, i18nProperties);
    const nonIconKey = setI18nProperty(buttonName,
                                       "nonIcon",
                                       applyTranslation(definition.nonIcon,
                                                        buttonName, "nonIcon"),
                                       i18nProperties);
    return {
        icon: definition.svg_icon,
        nonIconKey: nonIconKey ? `composer.${nonIconKey}` : null,
        titleKey: `composer.${titleKey}`,
        elementId: makeButtonIdentifier(buttonName),
        action: action,
        buttonName: buttonName,
        definition: definition,
    };
}


// Add a button directly to the toolbar.
//
function addToolbarButton(toolbar, toolbarGroup, buttonSpec, i18nProperties) {
    const {icon, nonIconKey, titleKey, elementId, action,
          } = makeCommonButtonOptions(buttonSpec, i18nProperties);
    toolbar.addButton({
        id: elementId,
        group: toolbarGroup,
        icon: nonIconKey ? null : icon,
        label: nonIconKey,
        title: titleKey,
        shortcut: buttonSpec.shortcut,
        perform: action,
        preventFocus: true, // prevent input focus from jumping to the button
        trimLeading: true, // remove leading whitespace from the selection
        // Additional parameters:
        //
        // tabindex
        // className
        // label - i18n-key of text to use *instead* of icon
        //         (specify label or icon, not both)
        //         ...only room for one character, really.
        //         ...but, opens up possibility to use emoji instead of icon 🤔
        // action
        // condition
        // shortcutAction
        // unshift  - if true, add button to beginning of group (versus end)
        // popupMenu  - set true only if this is *the* magic popup-menu button
    });
}


// Add a button directly to the popup menu under the ⚙️ button.
//
function addPopupMenuButton(api, buttonSpec, i18nProperties) {
    const {icon, titleKey, elementId, action,
           buttonName, definition
          } = makeCommonButtonOptions(buttonSpec, i18nProperties);
    const hoverKey = setI18nProperty(buttonName, "hover",
                                     applyTranslation(definition.popupHover,
                                                      buttonName, "popupHover"),
                                     i18nProperties);
    api.addComposerToolbarPopupMenuOption({
        icon: icon,  // icon on menu entry
        label: titleKey,  // text label (next to icon) on menu entry
        // title => hover-text on entry (falls-back to label?)
        title: hoverKey ? `composer.${hoverKey}` : titleKey,
        name: name,  // data-name attribute (falls-back to label)
        shortcut: buttonSpec.shortcut,
        action: (toolbarEvent) => {
            trimLeading(toolbarEvent.selected);
            action(toolbarEvent);
        },
        // Additional parameters:
        //
        // condition - boolean, function,
        //               or internal property in ComposerService
    });
}


// Parse a button entry from the layout array.  Entries have the format:
//
//     [when,]buttonName,[shortcut],[group]
//
//       when = X|M|D  (X - never, M - mobile-only, D - desktop-only)
//
//       shortcut = keyboard shortcut specifier (e.g., "shift+x")
//
//       group = name of a toggle-group
//
function parseLayoutEntry(entry) {
    let result = { allowDesktop: true,
                   allowMobile: true, };

    let pieces = entry.split(",");
    // Check for the optional "when" specifier.
    if (pieces[0] === "X") {  // never --- skip this entry
        result.allowDesktop = false;
        result.allowMobile = false;
        pieces.shift();
    } else if (pieces[0] === "M") {  // mobile-only
        result.allowDesktop = false;
        pieces.shift();
    } else if (pieces[0] === "D") {  // desktop-only
        result.allowMobile = false;
        pieces.shift();
    }
    // Pull out remaining pieces.
    result.buttonSpec = {
        name: pieces[0],
        shortcut: pieces[1],
        toggleGroup: pieces[2],
    };
    return result;
}


function parseLayout(api) {
    const result = {
        toolbar: [],
        gearmenu: [],
    };

    const capabilities = api.container.lookup("service:capabilities");

    // Until a section is specified, toss buttons in the "extras" toolbar group.
    let currentSection = SECTIONS.EXTRAS;

    for (const entry of settings.layout.split("|")) {
        try {
            // Check for a SECTION entry first.
            if (entry in SECTIONS) {
                currentSection = SECTIONS[entry];
                continue;
            }

            // Anything else is some kind of button entry.
            const {buttonSpec,
                   allowDesktop,
                   allowMobile} = parseLayoutEntry(entry);

            // Skip entry if not wanted on this view.
            if ((!capabilities.isMobileDevice && !allowDesktop) ||
                (capabilities.isMobileDevice && !allowMobile)) {
                continue;
            }

            if (!(buttonSpec.name in BUTTONS)) {
                throw new Error(`Unknown button: '${buttonSpec.name}'`);
            }

            const toggleGroup = buttonSpec.toggleGroup;
            if (toggleGroup) {
                TOGGLE_GROUPS[toggleGroup] ||= [];  // ensure group exists
                TOGGLE_GROUPS[toggleGroup].push(buttonSpec);
            }

            switch (currentSection[0]) {
            case Place.TOOLBAR:
                result.toolbar.push([currentSection[1], buttonSpec]);
                break;
            case Place.GEARMENU:
                result.gearmenu.push(buttonSpec);
                break;
            default:
                throw new Error(`Unknown placement type: ${currentSection[0]}`);
            }
        } catch (error) {
            console.error(CBBKEY, entry, error);
        }
    }
    return result;
}


export default apiInitializer("1.13.0", (api) => {

    // Create a container for our i18n key/value pairs...
    const i18nProperties = {}

    // ...which we stick into Composer's translation table, so that it can use
    // the i18n keys/values which we will generate for our buttons.
    I18n.translations[I18n.currentLocale()].js.composer[CBBKEY] = i18nProperties;

    // api.addComposerToolbarPopupMenuOption() does not seem to have any effect
    // when called within an api.onToolbarCreate() callback.  So, we need to
    // parse all the settings up-front, in order to define any pop-up buttons
    // right now.  We cannot defer until toolbar-creation time.
    //
    // TODO(maddog) Somehow defer layout parsing/etc until actually needed
    //              (e.g., first time a Composer is constructed?).

    // Re-express our 'buttons' setting as a map keyed on button name,
    // for easy lookup.
    BUTTONS = Object.fromEntries(settings.buttons.map((s) => [s.name, s]));

    // Grab any overrides for the current locale from 'translations' setting.
    TRANSLATIONS = settings.translations.find(
        (t) => t.locale === I18n.currentLocale())?.translations;

    // Parse our 'layout' setting.
    TOGGLE_GROUPS = {};
    let layout = parseLayout(api);

    // Define gear-menu pop-up buttons (which get constructed/destroyed when
    // the menu is opened/closed).
    for (const buttonSpec of layout.gearmenu) {
        try {
            addPopupMenuButton(api, buttonSpec, i18nProperties);
        } catch (error) {
            console.error(CBBKEY, error);
        }
    }

    // Register a callback to define the toolbar buttons when the toolbar is
    // eventually created.
    api.onToolbarCreate(function(toolbar) {
        for (const [toolbarGroup, buttonSpec] of layout.toolbar) {
            try {
                addToolbarButton(toolbar, toolbarGroup, buttonSpec,
                                 i18nProperties);
            } catch (error) {
                console.error(CBBKEY, error);
            }
        }
    });
});
