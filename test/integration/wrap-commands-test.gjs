import { tracked } from "@glimmer/tracking";
import { click, render, settled, waitFor } from "@ember/test-helpers";
import { module, test } from "qunit";
import DEditor from "discourse/components/d-editor";
import {
  registerRichEditorExtension,
  resetRichEditorExtensions,
} from "discourse/lib/composer/rich-editor-extensions";
import { serializeAttributes } from "discourse/lib/wrap-utils";
import { setupRenderingTest } from "discourse/tests/helpers/component-test";
import { setupRichEditor } from "discourse/tests/helpers/rich-editor-helper";

// The bonanza extension defined inline for test isolation — mirrors
// the commands/serializeNode registered in api-initializer.js.
const bonanzaExtension = {
  commands: ({ schema, pmCommands, utils, pmState, pmModel }) => ({
    cbbToggleMark: (markName) => (state, dispatch) => {
      const mark = schema.marks[markName];
      if (!mark) {
        return false;
      }
      return pmCommands.toggleMark(mark)(state, dispatch);
    },

    cbbApplySurround: (head, tail, exampleContent) => (state, dispatch) => {
      const { from, to } = state.selection;

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
        tr.doc
          .slice(mappedFrom, mappedTo)
          .content.forEach((n) => inlineNodes.push(n));
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
            const $toAdj =
              selection.$to.parentOffset === 0 &&
              selection.$to.depth > 0 &&
              selection.$to.pos > from
                ? state.doc.resolve(selection.$to.pos - 1)
                : selection.$to;

            if (selection.$from.nodeBefore?.type === schema.nodes.hard_break) {
              tr.split(from);
              tr.delete(from - 1, from);
            }

            const mappedFrom = tr.mapping.map(from);
            const mappedToAdj = tr.mapping.map($toAdj.pos);
            const $resolvedFrom = tr.doc.resolve(mappedFrom);
            const $resolvedToAdj = tr.doc.resolve(mappedToAdj);

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
      const doc = utils.convertFromMarkdown("* [ ] checklist item");
      const listNode = doc?.content?.firstChild;
      if (!listNode) {
        return false;
      }
      const { $from } = state.selection;
      const depth = $from.depth > 0 ? $from.depth : 1;
      const blockNode = $from.node(depth);
      const blockStart = $from.before(depth);
      const blockEnd = $from.after(depth);
      let tr;
      if (blockNode.content.size === 0) {
        tr = state.tr.replaceWith(blockStart, blockEnd, listNode);
      } else {
        tr = state.tr.insert(blockEnd, listNode);
      }
      dispatch?.(tr);
      return true;
    },
  }),

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
};

// ─── Helpers ────────────────────────────────────────────────────────────────

// prosemirror-state cannot be statically imported in theme context.
// Derive TextSelection by reading the constructor off the view's current
// selection — which is always a TextSelection at editor startup.
function textSel(view, from, to) {
  return view.state.selection.constructor.create(view.state.doc, from, to);
}

async function setupBonanzaEditor(markdown) {
  const self = new (class {
    @tracked value = markdown;
    textManipulation = null;
  })();

  const handleSetup = (tm) => {
    self.textManipulation = tm;
  };

  await render(
    <template>
      <DEditor
        @value={{self.value}}
        @processPreview={{false}}
        @onSetup={{handleSetup}}
      />
    </template>
  );

  await click(".composer-toggle-switch");
  await waitFor(".ProseMirror");
  await settled();

  return self;
}

// Returns the start position of the first occurrence of searchText in the doc.
function findTextPos(view, searchText) {
  let found = null;
  view.state.doc.descendants((node, pos) => {
    if (found !== null) {
      return false;
    }
    if (node.isText && node.text.includes(searchText)) {
      found = pos + node.text.indexOf(searchText);
    }
  });
  return found;
}

// Selects searchText within the editor (first occurrence).
function selectText(view, searchText) {
  const from = findTextPos(view, searchText);
  if (from === null) {
    throw new Error(`"${searchText}" not found in doc`);
  }
  view.dispatch(
    view.state.tr.setSelection(textSel(view, from, from + searchText.length))
  );
}

// Selects from the start of fromText to the end of toText.
function selectRange(view, fromText, toText) {
  const from = findTextPos(view, fromText);
  const to = findTextPos(view, toText);
  if (from === null || to === null) {
    throw new Error("Text not found");
  }
  view.dispatch(
    view.state.tr.setSelection(textSel(view, from, to + toText.length))
  );
}

// Returns the full markdown of the current editor state.
function getMarkdown(tm) {
  return tm.convertToMarkdown(tm.view.state.doc);
}

// ─── Module: serializer (wrap_block override) ────────────────────────────────

module(
  "Integration | Component | bonanza-wrap-commands - serializer",
  function (hooks) {
    setupRenderingTest(hooks);

    hooks.beforeEach(async function () {
      this.siteSettings.rich_editor = true;
      await resetRichEditorExtensions();
      registerRichEditorExtension(bonanzaExtension);
    });

    hooks.afterEach(() => resetRichEditorExtensions());

    test("wrap_block round-trips a single paragraph without trailing blank line", async function (assert) {
      const input = "[wrap=foo]\nhello\n[/wrap]";
      const [self] = await setupRichEditor(assert, input);
      assert.strictEqual(self.value, input);
    });

    test("wrap_block with no named wrap round-trips", async function (assert) {
      const input = "[wrap]\nhello world\n[/wrap]";
      const [self] = await setupRichEditor(assert, input);
      assert.strictEqual(self.value, input);
    });

    test("wrap_block with extra attributes round-trips", async function (assert) {
      const input = "[wrap=toc id=nav]\ncontents\n[/wrap]";
      const [self] = await setupRichEditor(assert, input);
      assert.strictEqual(self.value, input);
    });

    test("wrap_block with two paragraphs collapses blank line between them", async function (assert) {
      const [self] = await setupRichEditor(
        assert,
        "[wrap]\nfirst\n\nsecond\n[/wrap]"
      );
      assert.strictEqual(self.value, "[wrap]\nfirst\nsecond\n[/wrap]");
    });

    test("wrap_inline round-trips", async function (assert) {
      const input = "before [wrap=foo]inside[/wrap] after";
      const [self] = await setupRichEditor(assert, input);
      assert.strictEqual(self.value, input);
    });

    test("wrap_block does not gain blank lines on repeated round-trips", async function (assert) {
      const input = "[wrap]\nline\n[/wrap]";
      const [self] = await setupRichEditor(assert, input);
      assert.strictEqual(self.value, input, "value is stable after round-trip");
    });
  }
);

// ─── Module: cbbInsertWrap ───────────────────────────────────────────────────

module(
  "Integration | Component | bonanza-wrap-commands - cbbInsertWrap",
  function (hooks) {
    setupRenderingTest(hooks);

    hooks.beforeEach(async function () {
      this.siteSettings.rich_editor = true;
      await resetRichEditorExtensions();
      registerRichEditorExtension(bonanzaExtension);
    });

    hooks.afterEach(() => resetRichEditorExtensions());

    // ── block mode ──────────────────────────────────────────────────────────

    test("block mode: wraps a single selected paragraph", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello world");
      tm.commands.cbbInsertWrap({}, "block", "text");
      await settled();

      assert.strictEqual(getMarkdown(tm), "[wrap]\nhello world\n[/wrap]");
    });

    test("block mode: wraps with named wrap attribute", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello world");
      tm.commands.cbbInsertWrap({ wrap: "spoiler" }, "block", "text");
      await settled();

      assert.strictEqual(
        getMarkdown(tm),
        "[wrap=spoiler]\nhello world\n[/wrap]"
      );
    });

    test("block mode: wraps multiple selected paragraphs", async function (assert) {
      const self = await setupBonanzaEditor("first\n\nsecond");
      const { textManipulation: tm } = self;

      selectRange(tm.view, "first", "second");
      tm.commands.cbbInsertWrap({}, "block", "text");
      await settled();

      assert.strictEqual(getMarkdown(tm), "[wrap]\nfirst\nsecond\n[/wrap]");
    });

    test("block mode: $to at block boundary wraps only the preceding block", async function (assert) {
      const self = await setupBonanzaEditor("first\n\nsecond");
      const { textManipulation: tm } = self;

      // Position $to at the very start of the second paragraph (parentOffset === 0)
      const from = findTextPos(tm.view, "first");
      const secondParaStart = findTextPos(tm.view, "second") - 1; // just before "second"
      tm.view.dispatch(
        tm.view.state.tr.setSelection(textSel(tm.view, from, secondParaStart))
      );
      tm.commands.cbbInsertWrap({}, "block", "text");
      await settled();

      const md = getMarkdown(tm);
      assert.true(
        md.startsWith("[wrap]\nfirst\n[/wrap]"),
        "wraps only the first paragraph"
      );
      assert.true(md.includes("second"), "second paragraph is preserved");
    });

    test("block mode: selection starting after a hard_break splits into a new paragraph", async function (assert) {
      // Two-space hard break: "line1  \nline2" → paragraph with hard_break
      const self = await setupBonanzaEditor("line1  \nline2");
      const { textManipulation: tm } = self;

      selectText(tm.view, "line2");
      tm.commands.cbbInsertWrap({}, "block", "text");
      await settled();

      const md = getMarkdown(tm);
      assert.true(
        md.includes("[wrap]\nline2\n[/wrap]"),
        "line2 is wrapped in its own block"
      );
      assert.true(md.includes("line1"), "line1 is preserved outside the wrap");
      assert.false(
        md.includes("[wrap]\n\nline2"),
        "no blank line inside [wrap]"
      );
    });

    test("block mode: empty selection inserts an empty wrap_block", async function (assert) {
      const self = await setupBonanzaEditor("");
      const { textManipulation: tm } = self;

      // Cursor at start of empty doc
      tm.commands.cbbInsertWrap({ wrap: "details" }, "block", "text");
      await settled();

      const md = getMarkdown(tm);
      assert.true(md.includes("[wrap=details]"), "wrap_block is inserted");
      assert.true(md.includes("[/wrap]"), "wrap_block is closed");
    });

    // ── inline mode ─────────────────────────────────────────────────────────

    test("inline mode: wraps selected text as wrap_inline", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello");
      tm.commands.cbbInsertWrap({}, "inline", "text");
      await settled();

      assert.strictEqual(getMarkdown(tm), "[wrap]hello[/wrap] world");
    });

    test("inline mode: wraps with named attribute", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello");
      tm.commands.cbbInsertWrap({ wrap: "highlight" }, "inline", "text");
      await settled();

      assert.strictEqual(getMarkdown(tm), "[wrap=highlight]hello[/wrap] world");
    });

    test("inline mode: empty selection inserts placeholder", async function (assert) {
      const self = await setupBonanzaEditor("hello");
      const { textManipulation: tm } = self;

      // Collapse selection to a cursor (empty)
      const pos = findTextPos(tm.view, "hello");
      tm.view.dispatch(
        tm.view.state.tr.setSelection(textSel(tm.view, pos, pos))
      );
      tm.commands.cbbInsertWrap({}, "inline", "my placeholder");
      await settled();

      const md = getMarkdown(tm);
      assert.true(
        md.includes("[wrap]my placeholder[/wrap]"),
        "placeholder is used"
      );
    });

    // ── multiline mode ───────────────────────────────────────────────────────

    test("multiline mode: wraps a single line as wrap_inline", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello world");
      tm.commands.cbbInsertWrap({}, "multiline", "text");
      await settled();

      assert.strictEqual(getMarkdown(tm), "[wrap]hello world[/wrap]");
    });

    test("multiline mode: wraps each hard_break-separated line independently", async function (assert) {
      // "line1  \nline2" produces a paragraph with a hard_break
      const self = await setupBonanzaEditor("line1  \nline2");
      const { textManipulation: tm } = self;

      selectRange(tm.view, "line1", "line2");
      tm.commands.cbbInsertWrap({}, "multiline", "text");
      await settled();

      assert.strictEqual(
        getMarkdown(tm),
        "[wrap]line1[/wrap]\n[wrap]line2[/wrap]"
      );
    });

    test("multiline mode: wraps each paragraph in a multi-paragraph selection", async function (assert) {
      const self = await setupBonanzaEditor("first\n\nsecond");
      const { textManipulation: tm } = self;

      selectRange(tm.view, "first", "second");
      tm.commands.cbbInsertWrap({ wrap: "foo" }, "multiline", "text");
      await settled();

      const md = getMarkdown(tm);
      assert.true(
        md.includes("[wrap=foo]first[/wrap]"),
        "first paragraph is wrapped"
      );
      assert.true(
        md.includes("[wrap=foo]second[/wrap]"),
        "second paragraph is wrapped"
      );
    });

    test("multiline mode: empty selection inserts placeholder wrap_inline", async function (assert) {
      const self = await setupBonanzaEditor("hello");
      const { textManipulation: tm } = self;

      const pos = findTextPos(tm.view, "hello");
      tm.view.dispatch(
        tm.view.state.tr.setSelection(textSel(tm.view, pos, pos))
      );
      tm.commands.cbbInsertWrap({}, "multiline", "my text");
      await settled();

      const md = getMarkdown(tm);
      assert.true(
        md.includes("[wrap]my text[/wrap]"),
        "placeholder wrap_inline is inserted"
      );
    });
  }
);

// ─── Module: cbbApplySurround ────────────────────────────────────────────────

module(
  "Integration | Component | bonanza-wrap-commands - cbbApplySurround",
  function (hooks) {
    setupRenderingTest(hooks);

    hooks.beforeEach(async function () {
      this.siteSettings.rich_editor = true;
      await resetRichEditorExtensions();
      registerRichEditorExtension(bonanzaExtension);
    });

    hooks.afterEach(() => resetRichEditorExtensions());

    test("surrounds selected text with HTML tags", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello");
      tm.commands.cbbApplySurround("<mark>", "</mark>", "text");
      await settled();

      assert.strictEqual(getMarkdown(tm), "<mark>hello</mark> world");
    });

    test("surrounds selected text with BBCode tags", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello");
      tm.commands.cbbApplySurround("<big>", "</big>", "text");
      await settled();

      assert.strictEqual(getMarkdown(tm), "<big>hello</big> world");
    });

    test("empty selection inserts head+example+tail", async function (assert) {
      const self = await setupBonanzaEditor("hello");
      const { textManipulation: tm } = self;

      const pos = findTextPos(tm.view, "hello");
      tm.view.dispatch(
        tm.view.state.tr.setSelection(textSel(tm.view, pos, pos))
      );
      tm.commands.cbbApplySurround("<mark>", "</mark>", "example");
      await settled();

      const md = getMarkdown(tm);
      assert.true(
        md.includes("<mark>example</mark>"),
        "example content is used"
      );
    });

    test("toggles off HTML tag when cursor is inside matching node", async function (assert) {
      // Start with already-wrapped text so we can toggle it off
      const self = await setupBonanzaEditor("<mark>hello</mark> world");
      const { textManipulation: tm } = self;

      // Place cursor inside the <mark> node
      const pos = findTextPos(tm.view, "hello");
      tm.view.dispatch(
        tm.view.state.tr.setSelection(textSel(tm.view, pos + 1, pos + 1))
      );
      tm.commands.cbbApplySurround("<mark>", "</mark>", "text");
      await settled();

      assert.strictEqual(getMarkdown(tm), "hello world");
    });

    test("surrounds with symmetric markdown delimiters", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "world");
      tm.commands.cbbApplySurround("<sub>", "</sub>", "text");
      await settled();

      assert.strictEqual(getMarkdown(tm), "hello <sub>world</sub>");
    });
  }
);

// ─── Module: cbbToggleMark ───────────────────────────────────────────────────

module(
  "Integration | Component | bonanza-wrap-commands - cbbToggleMark",
  function (hooks) {
    setupRenderingTest(hooks);

    hooks.beforeEach(async function () {
      this.siteSettings.rich_editor = true;
      await resetRichEditorExtensions();
      registerRichEditorExtension(bonanzaExtension);
    });

    hooks.afterEach(() => resetRichEditorExtensions());

    test("applies underline mark to selected text", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello");
      tm.commands.cbbToggleMark("underline");
      await settled();

      assert.strictEqual(getMarkdown(tm), "[u]hello[/u] world");
    });

    test("applies strikethrough mark to selected text", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello");
      tm.commands.cbbToggleMark("strikethrough");
      await settled();

      assert.strictEqual(getMarkdown(tm), "~~hello~~ world");
    });

    test("toggles off underline when mark is already applied", async function (assert) {
      const self = await setupBonanzaEditor("[u]hello[/u] world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello");
      tm.commands.cbbToggleMark("underline");
      await settled();

      assert.strictEqual(getMarkdown(tm), "hello world");
    });

    test("toggles off strikethrough when mark is already applied", async function (assert) {
      const self = await setupBonanzaEditor("~~hello~~ world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello");
      tm.commands.cbbToggleMark("strikethrough");
      await settled();

      assert.strictEqual(getMarkdown(tm), "hello world");
    });

    test("does nothing for an unknown mark name", async function (assert) {
      const self = await setupBonanzaEditor("hello world");
      const { textManipulation: tm } = self;

      selectText(tm.view, "hello");
      const result = tm.commands.cbbToggleMark("nonexistent_mark");
      await settled();

      assert.false(result, "returns false for unknown mark");
      assert.strictEqual(getMarkdown(tm), "hello world", "doc is unchanged");
    });
  }
);

// ─── Module: cbbInsertChecklist ──────────────────────────────────────────────

module(
  "Integration | Component | bonanza-wrap-commands - cbbInsertChecklist",
  function (hooks) {
    setupRenderingTest(hooks);

    hooks.beforeEach(async function () {
      this.siteSettings.rich_editor = true;
      await resetRichEditorExtensions();
      registerRichEditorExtension(bonanzaExtension);
    });

    hooks.afterEach(() => resetRichEditorExtensions());

    test("inserts a checklist list item", async function (assert) {
      const self = await setupBonanzaEditor("");
      const { textManipulation: tm } = self;

      tm.commands.cbbInsertChecklist();
      await settled();

      const md = getMarkdown(tm);
      assert.true(
        md.includes("* [ ] checklist item"),
        "checklist markdown is inserted"
      );
    });

    test("inserts checklist in a non-empty doc", async function (assert) {
      const self = await setupBonanzaEditor("some text");
      const { textManipulation: tm } = self;

      // Place cursor at end of doc
      const endPos = tm.view.state.doc.content.size - 1;
      tm.view.dispatch(
        tm.view.state.tr.setSelection(textSel(tm.view, endPos, endPos))
      );
      tm.commands.cbbInsertChecklist();
      await settled();

      const md = getMarkdown(tm);
      assert.true(md.includes("* [ ] checklist item"), "checklist is inserted");
    });
  }
);
