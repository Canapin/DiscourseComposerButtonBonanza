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
import {
  parseAttributesString,
  serializeAttributes,
} from "discourse/lib/wrap-utils";
import I18n from "discourse-i18n";

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
  TOOLBAR: 1, // directly in the toolbar
  GEARMENU: 2, // hidden in the "⚙️" popup menu
});

// Define the "SECTION" keywords used in the 'layout' setting.
const SECTIONS = Object.freeze({
  STYLES: [Place.TOOLBAR, "fontStyles"],
  INSERTIONS: [Place.TOOLBAR, "insertions"],
  EXTRAS: [Place.TOOLBAR, "extras"],
  GEARMENU: [Place.GEARMENU],
});

// Override the defaultValue for a button's parameter, if a translation
// (for the current locale) has been specified in our 'translations' settings.
function applyTranslation(defaultValue, buttonName, paramName) {
  if (!TRANSLATIONS) {
    return defaultValue;
  }
  const key = `${buttonName}.${paramName}`;
  const translation = TRANSLATIONS.find((e) => e.key === key)?.value;
  return translation ?? defaultValue;
}

// Set a key/value pair, for the specified button, in i18nProperties.
//
// Returns the property's key.  If value is falsy, set no key and return null.
//
function setI18nProperty(buttonName, propName, propValue, i18nProperties) {
  if (!propValue) {
    return null;
  }
  i18nProperties[buttonName] ||= {}; // ensure path exists
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
  while (
    freshStart < selection.value.length &&
    /\s/.test(selection.value.charAt(freshStart))
  ) {
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
function makeSurroundAction(
  buttonName,
  head,
  tail,
  exampleText,
  lineMode,
  i18nProperties
) {
  const exampleTextKey = setI18nProperty(
    buttonName,
    "exampleText",
    exampleText,
    i18nProperties
  );
  return (toolbarEvent) => {
    // Rich editor path: use ProseMirror-aware commands when available.
    if (toolbarEvent.commands) {
      // Headings need setBlockType, not a text surround.
      const headingMatch = /^(#{1,3}) $/.exec(head);
      if (headingMatch) {
        toolbarEvent.applyHeading(headingMatch[1].length, exampleTextKey);
        return;
      }
      // Underline and strikethrough are proper marks — use toggleMark so
      // they can be toggled off as well as on.
      if (
        head === "[u]" &&
        tail === "[/u]" &&
        toolbarEvent.commands.cbbToggleMark
      ) {
        toolbarEvent.commands.cbbToggleMark("underline");
        return;
      }
      if (
        head === "~~" &&
        tail === "~~" &&
        toolbarEvent.commands.cbbToggleMark
      ) {
        toolbarEvent.commands.cbbToggleMark("strikethrough");
        return;
      }
      // Wrap BBcode: create wrap_inline or wrap_block directly.
      if (
        head.includes("[wrap") &&
        tail.includes("[/wrap]") &&
        toolbarEvent.commands.cbbInsertWrap
      ) {
        const match = head.match(/\[wrap([^\]]*)\]/);
        const attrs = match ? parseAttributesString(match[1]) : {};
        toolbarEvent.commands.cbbInsertWrap(
          attrs,
          lineMode,
          exampleText || "text"
        );
        return;
      }
      // Generic inline surround (HTML tags, BBCode, etc.).
      if (toolbarEvent.commands.cbbApplySurround) {
        toolbarEvent.commands.cbbApplySurround(head, tail, exampleText || "");
        return;
      }
    }
    // Legacy (textarea) editor path.
    toolbarEvent.applySurround(head, tail, exampleTextKey, {
      multiline: lineMode === "multiline",
      useBlockMode: lineMode === "block",
    });
  };
}

// Create a 'list' action callback.
//
function makeListAction(
  buttonName,
  head,
  exampleText,
  lineMode,
  i18nProperties
) {
  const exampleTextKey = setI18nProperty(
    buttonName,
    "exampleText",
    exampleText,
    i18nProperties
  );
  return (toolbarEvent) => {
    // Rich editor path: the checklist prefix is not a standard ProseMirror
    // list type, so use a dedicated command to build the list node.
    if (
      buttonName === "checklist" &&
      toolbarEvent.commands?.cbbInsertChecklist
    ) {
      toolbarEvent.commands.cbbInsertChecklist();
      return;
    }
    // Legacy (textarea) editor path.
    toolbarEvent.applyList(head, exampleTextKey, {
      multiline: lineMode === "multiline",
      useBlockMode: lineMode === "block",
    });
  };
}

// Create a 'toggleGroup' action callback.
//
function makeToggleAction(buttonName, groupName, startHidden) {
  if (!TOGGLE_GROUPS[groupName]) {
    throw new Error(
      `No buttons are assigned to toggle-group '${groupName}' for button '${buttonName}'.`
    );
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
    stylesheet.insertRule(`.${identifier} { display: none !important; }`);
    stylesheet.insertRule(
      `[data-name="${identifier}"] { display: none !important; }`
    );
  }

  document.adoptedStyleSheets.push(stylesheet);

  // Now, the actual event handler can just flip the bits.
  return () => {
    isHidden = !isHidden;
    stylesheet.disabled = !isHidden;
  };
}

// Construct the action (toolbar event handler) for a button.
//
function makeAction(buttonName, definition, i18nProperties) {
  switch (definition.action) {
    case Action.insert:
      return makeInsertAction(
        buttonName,
        applyTranslation(definition.prefix, buttonName, "prefix")
      );
    case Action.surround:
      return makeSurroundAction(
        buttonName,
        applyTranslation(definition.prefix, buttonName, "prefix"),
        applyTranslation(definition.suffix, buttonName, "suffix"),
        applyTranslation(definition.exampleText, buttonName, "exampleText"),
        definition.lineMode,
        i18nProperties
      );
    case Action.list:
      return makeListAction(
        buttonName,
        applyTranslation(definition.prefix, buttonName, "prefix"),
        applyTranslation(definition.exampleText, buttonName, "exampleText"),
        definition.lineMode,
        i18nProperties
      );
    case Action.toggleGroup:
      return makeToggleAction(
        buttonName,
        applyTranslation(definition.groupName, buttonName, "groupName"),
        applyTranslation(definition.startHidden, buttonName, "startHidden"),
        i18nProperties
      );
    default:
      throw new Error(
        `Unknown action for button ${buttonName}:  ${definition.action}`
      );
  }
}

// Construct the button options/parameters that are common to both toolbar
// buttons and popup menu buttons.
//
function makeCommonButtonOptions(buttonSpec, i18nProperties) {
  const buttonName = buttonSpec.name;
  const definition = BUTTONS[buttonName];
  const titleKey = setI18nProperty(
    buttonName,
    "title",
    applyTranslation(definition.title, buttonName, "title"),
    i18nProperties
  );
  const action = makeAction(buttonName, definition, i18nProperties);
  const nonIconKey = setI18nProperty(
    buttonName,
    "nonIcon",
    applyTranslation(definition.nonIcon, buttonName, "nonIcon"),
    i18nProperties
  );
  return {
    icon: definition.svg_icon,
    nonIconKey: nonIconKey ? `composer.${nonIconKey}` : null,
    titleKey: `composer.${titleKey}`,
    elementId: makeButtonIdentifier(buttonName),
    action,
    buttonName,
    definition,
  };
}

// Add a button directly to the toolbar.
//
function addToolbarButton(toolbar, toolbarGroup, buttonSpec, i18nProperties) {
  const { icon, nonIconKey, titleKey, elementId, action } =
    makeCommonButtonOptions(buttonSpec, i18nProperties);
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
  const { icon, titleKey, action, buttonName, definition } =
    makeCommonButtonOptions(buttonSpec, i18nProperties);
  const hoverKey = setI18nProperty(
    buttonName,
    "hover",
    applyTranslation(definition.popupHover, buttonName, "popupHover"),
    i18nProperties
  );
  api.addComposerToolbarPopupMenuOption({
    icon, // icon on menu entry
    label: titleKey, // text label (next to icon) on menu entry
    // title => hover-text on entry (falls-back to label?)
    title: hoverKey ? `composer.${hoverKey}` : titleKey,
    name, // data-name attribute (falls-back to label)
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
  let result = { allowDesktop: true, allowMobile: true };

  let pieces = entry.split(",");
  // Check for the optional "when" specifier.
  if (pieces[0] === "X") {
    // never --- skip this entry
    result.allowDesktop = false;
    result.allowMobile = false;
    pieces.shift();
  } else if (pieces[0] === "M") {
    // mobile-only
    result.allowDesktop = false;
    pieces.shift();
  } else if (pieces[0] === "D") {
    // desktop-only
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
      const { buttonSpec, allowDesktop, allowMobile } = parseLayoutEntry(entry);

      // Skip entry if not wanted on this view.
      if (
        (!capabilities.isMobileDevice && !allowDesktop) ||
        (capabilities.isMobileDevice && !allowMobile)
      ) {
        continue;
      }

      if (!(buttonSpec.name in BUTTONS)) {
        throw new Error(`Unknown button: '${buttonSpec.name}'`);
      }

      const toggleGroup = buttonSpec.toggleGroup;
      if (toggleGroup) {
        TOGGLE_GROUPS[toggleGroup] ||= []; // ensure group exists
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
      // eslint-disable-next-line no-console
      console.error(CBBKEY, entry, error);
    }
  }
  return result;
}

export default apiInitializer((api) => {
  // Register ProseMirror commands so the toolbar buttons work correctly in
  // the rich editor.  The commands are keyed with a "cbb" prefix to avoid
  // collisions with commands from other extensions.
  //
  // toolbarEvent.commands is only populated in the rich editor; it is
  // undefined in the legacy textarea editor.  The action callbacks below
  // check for the presence of these commands as the rich-editor detector.
  api.registerRichEditorExtension({
    commands: ({ schema, pmCommands, utils, pmState, pmModel }) => ({
      // Toggle a named ProseMirror mark (underline, strikethrough).
      cbbToggleMark: (markName) => (state, dispatch) => {
        const mark = schema.marks[markName];
        if (!mark) {
          return false;
        }
        return pmCommands.toggleMark(mark)(state, dispatch);
      },

      // Generic inline surround: converts head+content+tail as markdown,
      // extracts the inline ProseMirror nodes, and replaces the current
      // selection with them.  This fixes the broken
      // convertFromMarkdown → replaceWith(paragraph_node) path that the
      // legacy applySurround uses in the rich editor.
      //
      // Also acts as a toggle: if the cursor or selection is already inside an
      // html_inline node whose tag matches the opening tag in `head` (e.g.
      // "<mark>" → "mark"), the node is unwrapped instead.
      cbbApplySurround: (head, tail, exampleContent) => (state, dispatch) => {
        const { from, to } = state.selection;

        // Toggle off if the selection start is inside a matching html_inline.
        const htmlTagMatch = /^<([a-z][a-z0-9-]*)>$/i.exec(head);
        if (htmlTagMatch && schema.nodes.html_inline) {
          const tag = htmlTagMatch[1].toLowerCase();
          const $from = state.selection.$from;
          for (let depth = $from.depth; depth >= 0; depth--) {
            const node = $from.node(depth);
            if (
              node.type === schema.nodes.html_inline &&
              node.attrs.tag === tag
            ) {
              const pos = $from.before(depth);
              dispatch?.(
                state.tr.replaceWith(pos, pos + node.nodeSize, node.content)
              );
              return true;
            }
          }
        }

        // Wrap an array of inline nodes by round-tripping through markdown.
        // Returns an array of replacement nodes, or null on parse failure.
        const wrapInlineNodes = (nodes) => {
          const frag = pmModel.Fragment.from(nodes);
          const tempDoc = pmModel.Fragment.from(
            schema.nodes.paragraph.create(null, frag)
          );
          const selectedMarkdown = utils.convertToMarkdown(tempDoc).trim();
          if (!selectedMarkdown) {
            return null;
          }
          const md = head + selectedMarkdown + tail;
          const parsed = utils.convertFromMarkdown(md);
          const first = parsed?.content?.firstChild;
          if (!first) {
            return null;
          }
          if (
            first.type.name === "paragraph" &&
            parsed.content.childCount === 1
          ) {
            const result = [];
            first.content.forEach((n) => result.push(n));
            return result;
          }
          return [first];
        };

        // Empty selection: insert head+example+tail at cursor.
        const { empty } = state.selection;
        if (empty) {
          const md = head + (exampleContent || "") + tail;
          const parsed = utils.convertFromMarkdown(md);
          const first = parsed?.content?.firstChild;
          if (!first) {
            return false;
          }
          const contentToInsert =
            first.type.name === "paragraph" && parsed.content.childCount === 1
              ? first.content
              : first;
          dispatch?.(state.tr.replaceWith(from, to, contentToInsert));
          return true;
        }

        // Non-empty selection: apply per block, and within each block split at
        // hard_break nodes so each visual line gets its own wrapper. This avoids
        // blank lines inside the markup (which create an HTML block instead of
        // inline HTML) and content loss from cross-paragraph selections.
        const tr = state.tr;
        const blockRanges = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.isBlock && node.inlineContent) {
            const contentStart = pos + 1;
            const contentEnd = pos + node.nodeSize - 1;
            const clipFrom = Math.max(contentStart, from);
            const clipTo = Math.min(contentEnd, to);
            if (clipFrom < clipTo) {
              blockRanges.push({ from: clipFrom, to: clipTo });
            }
            return false;
          }
        });

        if (blockRanges.length === 0) {
          return false;
        }

        blockRanges.reverse().forEach(({ from: bFrom, to: bTo }) => {
          const mappedFrom = tr.mapping.map(bFrom);
          const mappedTo = tr.mapping.map(bTo);

          const inlineNodes = [];
          tr.doc.nodesBetween(mappedFrom, mappedTo, (node) => {
            if (node.isInline) {
              inlineNodes.push(node);
              return false;
            }
          });
          if (!inlineNodes.length) {
            return;
          }

          const newNodes = [];
          let segment = [];

          const flushSegment = () => {
            if (!segment.length) {
              return;
            }
            newNodes.push(...(wrapInlineNodes(segment) ?? segment));
            segment = [];
          };

          for (const node of inlineNodes) {
            if (
              schema.nodes.hard_break &&
              node.type === schema.nodes.hard_break
            ) {
              flushSegment();
              newNodes.push(node);
            } else {
              segment.push(node);
            }
          }
          flushSegment();

          tr.replaceWith(mappedFrom, mappedTo, pmModel.Fragment.from(newNodes));
        });

        dispatch?.(tr);
        return true;
      },

      // Insert a [wrap] node of the appropriate type for the given lineMode.
      // multiline: wrap_inline per visual line (hard_break-separated).
      // inline:    wrap_inline around the selection as a single span.
      // block:     wrap_block around the selected block-level paragraphs.
      cbbInsertWrap:
        (attributes, lineMode, placeholderText) => (state, dispatch) => {
          const { selection } = state;
          const { from, to, empty } = selection;
          const attrs = { data: attributes };
          const tr = state.tr;

          if (lineMode === "multiline") {
            const wrapType = schema.nodes.wrap_inline;
            if (!wrapType) {
              return false;
            }
            if (empty) {
              tr.replaceWith(
                from,
                to,
                wrapType.create(attrs, schema.text(placeholderText || "text"))
              );
              dispatch?.(tr);
              return true;
            }
            // Collect paragraph blocks in the selection, process end→start so
            // earlier replacements don't shift later positions.
            const blockPositions = [];
            state.doc.nodesBetween(from, to, (node, pos) => {
              if (node.isBlock && node.inlineContent) {
                blockPositions.push(pos);
                return false;
              }
            });
            blockPositions.reverse().forEach((pos) => {
              const mappedPos = tr.mapping.map(pos);
              const node = tr.doc.nodeAt(mappedPos);
              if (!node) {
                return;
              }
              const contentStart = mappedPos + 1;
              const contentEnd = mappedPos + node.nodeSize - 1;
              const clipFrom = Math.max(contentStart, tr.mapping.map(from));
              const clipTo = Math.min(contentEnd, tr.mapping.map(to));
              if (clipFrom >= clipTo) {
                return;
              }
              // Split at hard_break nodes, wrapping each visual line
              // separately and keeping the hard_break as line separator.
              const sliced = tr.doc.slice(clipFrom, clipTo).content;
              const newNodes = [];
              let segment = [];
              sliced.forEach((child) => {
                if (
                  schema.nodes.hard_break &&
                  child.type === schema.nodes.hard_break
                ) {
                  if (segment.length) {
                    newNodes.push(
                      wrapType.create(attrs, pmModel.Fragment.from(segment))
                    );
                    segment = [];
                  }
                  newNodes.push(child);
                } else {
                  segment.push(child);
                }
              });
              if (segment.length) {
                newNodes.push(
                  wrapType.create(attrs, pmModel.Fragment.from(segment))
                );
              }
              if (newNodes.length) {
                tr.replaceWith(clipFrom, clipTo, newNodes);
              }
            });
            dispatch?.(tr);
            return true;
          }

          const wrapType =
            lineMode === "inline"
              ? schema.nodes.wrap_inline
              : schema.nodes.wrap_block;
          if (!wrapType) {
            return false;
          }

          if (lineMode === "inline") {
            const content = empty
              ? schema.text(placeholderText || "text")
              : state.doc.slice(from, to).content;
            tr.replaceWith(from, to, wrapType.create(attrs, content));
          } else {
            if (empty) {
              tr.replaceSelectionWith(
                wrapType.create(attrs, schema.nodes.paragraph.createAndFill())
              );
            } else {
              // If $to lands at a block boundary (parentOffset===0), nothing
              // of that block is selected — step back into the previous block.
              const $toAdj =
                selection.$to.parentOffset === 0 &&
                selection.$to.depth > 0 &&
                selection.$to.pos > from
                  ? state.doc.resolve(selection.$to.pos - 1)
                  : selection.$to;

              // When the selection starts right after a hard_break the "line"
              // lives inside the same paragraph node as preceding content.
              // Split at that boundary and remove the trailing hard_break so
              // the wrap opens at the visual line, not the paragraph start.
              if (
                selection.$from.nodeBefore?.type === schema.nodes.hard_break
              ) {
                tr.split(from);
                // The hard_break occupies [from-1, from) and positions before
                // the split point are unaffected by the split step.
                tr.delete(from - 1, from);
              }

              // Re-resolve positions through the accumulated mapping.
              const mappedFrom = tr.mapping.map(from);
              const mappedToAdj = tr.mapping.map($toAdj.pos);
              const $resolvedFrom = tr.doc.resolve(mappedFrom);
              const $resolvedToAdj = tr.doc.resolve(mappedToAdj);

              // sharedDepth+1 would be 2 when the whole selection is inside one
              // paragraph, pushing before()/after() into text level. Cap at
              // $resolvedFrom.depth to stay at block level in all cases.
              const sharedDepth = $resolvedFrom.sharedDepth(mappedToAdj);
              const wrapDepth = Math.min(sharedDepth + 1, $resolvedFrom.depth);
              const blockFrom = $resolvedFrom.before(wrapDepth);
              const blockTo = $resolvedToAdj.after(wrapDepth);
              tr.replaceWith(
                blockFrom,
                blockTo,
                wrapType.create(attrs, tr.doc.slice(blockFrom, blockTo).content)
              );
            }
          }

          dispatch?.(tr);
          return true;
        },

      cbbInsertChecklist: () => (state, dispatch) => {
        const { Slice } = pmModel;
        const { TextSelection } = pmState;
        const doc = utils.convertFromMarkdown("* [ ] checklist item");
        if (!doc?.content?.firstChild) {
          return false;
        }
        const tr = state.tr.replaceSelection(new Slice(doc.content, 0, 0));
        if (!tr.selection.$from.nodeAfter) {
          tr.setSelection(TextSelection.create(tr.doc, tr.selection.from + 1));
        }
        dispatch?.(tr);
        return true;
      },
    }),

    // Override to suppress the paragraph closeBlock \n\n that the default
    // serializer emits after each child, which would produce blank lines
    // between paragraphs and before [/wrap].
    serializeNode: {
      wrap_block(state, node) {
        const attrs = serializeAttributes(node.attrs?.data || {});
        state.write(`[wrap${attrs}]\n`);
        node.forEach((child, _, index) => {
          if (index > 0) {
            state.write("\n");
          }
          if (child.type.name === "paragraph") {
            state.renderInline(child);
          } else {
            state.render(child, node, index);
          }
        });
        state.write("\n[/wrap]");
        state.closeBlock(node);
      },
    },
  });

  // Create a container for our i18n key/value pairs...
  const i18nProperties = {};

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
    (t) => t.locale === I18n.currentLocale()
  )?.translations;

  // Parse our 'layout' setting.
  TOGGLE_GROUPS = {};
  let layout = parseLayout(api);

  // Define gear-menu pop-up buttons (which get constructed/destroyed when
  // the menu is opened/closed).
  for (const buttonSpec of layout.gearmenu) {
    try {
      addPopupMenuButton(api, buttonSpec, i18nProperties);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(CBBKEY, error);
    }
  }

  // Register a callback to define the toolbar buttons when the toolbar is
  // eventually created.
  api.onToolbarCreate(function (toolbar) {
    for (const [toolbarGroup, buttonSpec] of layout.toolbar) {
      try {
        addToolbarButton(toolbar, toolbarGroup, buttonSpec, i18nProperties);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(CBBKEY, error);
      }
    }
  });
});
