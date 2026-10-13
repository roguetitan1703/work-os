// Note editor schema, shared by the browser editor and the server (markdown conversion for Claude).
// Plain DOM renderers so it runs in both places. Custom pieces:
//   mention: inline link to a task (#12) or project; exported to markdown as [#12 Title](/tasks/12)
//   page:    block linking to a sub-page (a child note); exported as [📄 Title](/notes/<id>)

import { BlockNoteSchema, createBlockSpec, createInlineContentSpec, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';

export const Mention = createInlineContentSpec(
  {
    type: 'mention',
    propSchema: {
      kind: { default: 'task' as 'task' | 'project' },
      target: { default: '' }, // task ref ("12") or project id
      label: { default: '' }, // shown text, e.g. "#12 Send invoice"
    },
    content: 'none',
  },
  {
    render: ic => {
      const a = document.createElement('a');
      const { kind, target, label } = ic.props;
      a.href = kind === 'task' ? `/tasks/${target}` : `/projects/${target}`;
      a.textContent = label || (kind === 'task' ? `#${target}` : target);
      a.className = 'wo-mention';
      a.dataset.kind = kind;
      return { dom: a };
    },
  },
);

export const PageBlock = createBlockSpec(
  {
    type: 'page',
    propSchema: {
      noteId: { default: '' },
      title: { default: 'Untitled' },
    },
    content: 'none',
  },
  {
    render: block => {
      const a = document.createElement('a');
      a.href = `/notes/${block.props.noteId}`;
      a.className = 'wo-page-link';
      a.textContent = `📄 ${block.props.title || 'Untitled'}`;
      return { dom: a };
    },
    toExternalHTML: block => {
      const p = document.createElement('p');
      const a = document.createElement('a');
      a.href = `/notes/${block.props.noteId}`;
      a.textContent = `📄 ${block.props.title || 'Untitled'}`;
      p.appendChild(a);
      return { dom: p };
    },
  },
);

export const noteSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, page: PageBlock() },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: Mention },
});

export type NoteSchema = typeof noteSchema;
export type NoteBlock = NoteSchema['Block'];
export type NotePartialBlock = NoteSchema['PartialBlock'];
