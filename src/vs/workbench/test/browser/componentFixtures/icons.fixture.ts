/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toDisposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ComponentFixtureContext, defineComponentFixture, defineThemedFixtureGroup } from './fixtureUtils.js';

import '../../../../base/browser/ui/codicons/codiconStyles.js';


interface IconEntry {
	readonly name: string;
	readonly id: string;
	readonly className: string;
}

const iconEntries = Object.entries(Codicon)
	.map(([name, icon]): IconEntry => ({
		name,
		id: icon.id,
		className: ThemeIcon.asClassName(icon),
	}))
	.sort((a, b) => a.name.localeCompare(b.name));

export default defineThemedFixtureGroup({
	AllIcons: defineComponentFixture({
		labels: { kind: 'screenshot' },
		render: renderIcons,
	}),
});

function renderIcons({ container, disposableStore }: ComponentFixtureContext): void {
	container.style.padding = 'var(--vscode-spacing-size60, 6px)';
	container.style.overflow = 'auto';

	const style = document.createElement('style');
	style.textContent = `
		.icon-explorer {
			display: flex;
			flex-direction: column;
			gap: var(--vscode-spacing-size60, 6px);
			color: var(--vscode-foreground);
		}

		.icon-explorer-header {
			display: flex;
			align-items: center;
			gap: var(--vscode-spacing-size60, 6px);
			position: sticky;
			top: 0;
			z-index: 1;
			padding-bottom: var(--vscode-spacing-size40, 4px);
			background: var(--vscode-editor-background);
		}

		.icon-explorer-filter {
			min-width: 240px;
			padding: var(--vscode-spacing-size40, 4px) var(--vscode-spacing-size60, 6px);
			border: var(--vscode-strokeThickness, 1px) solid var(--vscode-input-border, transparent);
			border-radius: var(--vscode-cornerRadius-medium, 4px);
			color: var(--vscode-input-foreground);
			background: var(--vscode-input-background);
			font: inherit;
		}

		.icon-explorer-filter:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}

		.icon-explorer-count {
			color: var(--vscode-descriptionForeground);
			font-size: var(--vscode-font-size, 13px);
		}

		.icon-explorer-grid {
		display: grid;
			grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
			gap: var(--vscode-spacing-size60, 6px);
		}

		.icon-explorer-item {
			display: flex;
			min-width: 0;
			min-height: 72px;
			flex-direction: column;
			align-items: flex-start;
			gap: var(--vscode-spacing-size40, 4px);
			padding: var(--vscode-spacing-size60, 6px);
			border: var(--vscode-strokeThickness, 1px) solid var(--vscode-panel-border, transparent);
			border-radius: var(--vscode-cornerRadius-medium, 4px);
			background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
		}

		.icon-explorer-item:hover {
			border-color: var(--vscode-focusBorder);
			background: var(--vscode-list-hoverBackground);
		}

		.icon-explorer-glyph {
			color: var(--vscode-icon-foreground);
			font-size: var(--vscode-codiconFontSize, 16px);
		}

		.icon-explorer-name,
		.icon-explorer-id {
			max-width: 100%;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.icon-explorer-name {
			color: var(--vscode-foreground);
		}

		.icon-explorer-id {
			color: var(--vscode-descriptionForeground);
			font-size: var(--vscode-font-size, 13px);
		}

		.icon-explorer-empty {
			padding: var(--vscode-spacing-size80, 8px);
			color: var(--vscode-descriptionForeground);
		}
	`;
	container.appendChild(style);

	const root = document.createElement('div');
	root.className = 'icon-explorer';
	container.appendChild(root);

	const header = document.createElement('div');
	header.className = 'icon-explorer-header';
	root.appendChild(header);

	const filter = document.createElement('input');
	filter.className = 'icon-explorer-filter';
	filter.type = 'search';
	filter.placeholder = 'Filter icons by name or id';
	filter.setAttribute('aria-label', 'Filter icons by name or id');
	filter.autocomplete = 'off';
	filter.spellcheck = false;
	header.appendChild(filter);

	const count = document.createElement('span');
	count.className = 'icon-explorer-count';
	count.setAttribute('aria-live', 'polite');
	header.appendChild(count);

	const grid = document.createElement('div');
	grid.className = 'icon-explorer-grid';
	root.appendChild(grid);

	const renderGrid = (query: string): void => {
		const normalizedQuery = query.trim().toLowerCase();
		const visibleIcons = normalizedQuery.length === 0
			? iconEntries
			: iconEntries.filter(icon => icon.name.toLowerCase().includes(normalizedQuery) || icon.id.includes(normalizedQuery));

		count.textContent = `${visibleIcons.length} of ${iconEntries.length} icons`;
		const fragment = document.createDocumentFragment();

		for (const icon of visibleIcons) {
			fragment.appendChild(createIconCard(icon));
		}

		if (visibleIcons.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'icon-explorer-empty';
			empty.textContent = 'No icons match this filter.';
			fragment.appendChild(empty);
		}

		grid.replaceChildren(fragment);
	};

	const onFilterInput = (): void => renderGrid(filter.value);
	filter.addEventListener('input', onFilterInput);
	disposableStore.add(toDisposable(() => filter.removeEventListener('input', onFilterInput)));

	renderGrid('');
}

function createIconCard(icon: IconEntry): HTMLElement {
	const card = document.createElement('div');
	card.className = 'icon-explorer-item';
	card.title = `${icon.name} (${icon.id})`;

	const glyph = document.createElement('span');
	glyph.className = `icon-explorer-glyph ${icon.className}`;
	glyph.setAttribute('aria-hidden', 'true');
	card.appendChild(glyph);

	const name = document.createElement('code');
	name.className = 'icon-explorer-name';
	name.textContent = `Codicon.${icon.name}`;
	card.appendChild(name);

	const id = document.createElement('code');
	id.className = 'icon-explorer-id';
	id.textContent = icon.id;
	card.appendChild(id);

	return card;
}
