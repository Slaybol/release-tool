import type { Build, JiraIssue, Release } from './model.ts';

// Release notes are kept in marked sections so the tool can rebuild its own parts on every
// new build while keeping any section someone edited, in Release Tool or directly on GitHub.
export const SECTIONS = ['header', 'highlights', 'changes', 'known-issues', 'facts'] as const;
export type SectionId = (typeof SECTIONS)[number];
export const EDITABLE: SectionId[] = ['highlights', 'changes', 'known-issues'];
export const SECTION_TITLES: Record<SectionId, string> = {
  header: 'About this release', highlights: 'Highlights', changes: "What's changed", 'known-issues': 'Known issues', facts: 'Release facts'
};

const marker = (id: string) => `<!-- release-tool:${id} -->`;
const MARKER = /<!-- release-tool:([a-z-]+) -->/g;

export function render(sections: Record<string, string>): string {
  return SECTIONS.filter((id) => sections[id]?.trim()).map((id) => `${marker(id)}\n${sections[id].trim()}`).join('\n\n') + '\n';
}

export function parse(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const marks = [...body.matchAll(MARKER)];
  marks.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : body.length;
    out[m[1]] = body.slice(start, end).trim();
  });
  return out;
}

const norm = (s: string | undefined) => (s ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();

// Sections whose text on GitHub no longer matches what the tool last wrote: someone edited them there.
export function editedOnGitHub(body: string, generated: Record<string, string>): Record<string, string> {
  const current = parse(body);
  const edited: Record<string, string> = {};
  for (const id of EDITABLE) {
    if (current[id] !== undefined && generated[id] !== undefined && norm(current[id]) !== norm(generated[id])) edited[id] = current[id];
  }
  return edited;
}

export interface NotesContext {
  release: Release;
  build: Build;
  tag: string;
  previousTag?: string;
  githubNotes: string;
  jiraBaseUrl?: string;
  jiraProject: string;
  facts: string[];
}

export function generate(ctx: NotesContext): Record<SectionId, string> {
  const { release, build, tag, previousTag } = ctx;
  const range = previousTag ? `\`${previousTag}...${tag}\`` : 'the start of the repository';
  const open = release.jira.filter((i) => !/done|closed|resolved/i.test(i.status));
  const bugs = open.filter((i) => /bug/i.test(i.type));
  return {
    header: [
      `Release candidate **${build.version}** for ${release.name}, from build [${build.id}](${build.runUrl}) on \`${release.branch}\` (commit \`${build.sha.slice(0, 7)}\`).`,
      '',
      `_Managed by Release Tool. Changes compare ${range}. Sections are rebuilt for each new build unless someone has edited them, here or in Release Tool._`
    ].join('\n'),
    highlights: `## ${SECTION_TITLES.highlights}\n\n_No highlights yet. Edit this section to add them; your text is kept for later builds._`,
    changes: linkJira(stripTitle(ctx.githubNotes), ctx.jiraBaseUrl, ctx.jiraProject),
    'known-issues': `## ${SECTION_TITLES['known-issues']}\n\n` + (bugs.length ? bugs.map((i) => `- [${i.key}](${i.url}) ${i.summary}${i.blocker ? ' **(blocker)**' : ''}`).join('\n') : '_No open bugs on this fix version._'),
    facts: `## ${SECTION_TITLES.facts}\n\n` + ctx.facts.map((f) => `- ${f}`).join('\n')
  };
}

export function merge(fresh: Record<SectionId, string>, locked: Release['notes']['locked']): Record<string, string> {
  const out: Record<string, string> = { ...fresh };
  for (const [id, l] of Object.entries(locked)) out[id] = l.text;
  return out;
}

// GitHub's generated notes start with "## What's Changed"; keep the heading, as one level.
function stripTitle(s: string) {
  const t = s.trim();
  return t.startsWith('##') ? t : `## ${SECTION_TITLES.changes}\n\n${t}`;
}

export function linkJira(text: string, base: string | undefined, project: string): string {
  if (!base) return text;
  // Link bare keys of the configured project, like WEB-123, but not ones already inside a link.
  const re = new RegExp(`(?<![\\[\\/\\w-])(${project}-\\d+)(?![\\]\\w])`, 'g');
  return text.replace(re, (k) => `[${k}](${base.replace(/\/$/, '')}/browse/${k})`);
}

export function openBugs(issues: JiraIssue[]) {
  return issues.filter((i) => !/done|closed|resolved/i.test(i.status));
}
