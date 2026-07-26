/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import {
	IContextSkillService,
	IEffectiveSkill,
	ISkillManagementSnapshot,
	SkillOrigin,
	SkillOverride,
	SkillSection,
} from '../common/skillManagement.js';
import { MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID } from './canonicalConfigurationActions.js';
import './media/skillsView.css';

const sectionLabels: Readonly<Record<SkillSection, string>> = {
	enabled: localize('repositoryContextSkillsEnabled', 'Enabled'),
	available: localize('repositoryContextSkillsAvailable', 'Available'),
	needsAttention: localize('repositoryContextSkillsNeedsAttention', 'Needs attention'),
};

const originLabels: Readonly<Record<SkillOrigin, string>> = {
	global: localize('repositoryContextSkillOriginGlobal', 'Global'),
	repository: localize('repositoryContextSkillOriginRepository', 'Repository'),
	plugin: localize('repositoryContextSkillOriginPlugin', 'Plugin'),
};

const overrideLabels: Readonly<Record<SkillOverride, string>> = {
	inherit: localize('repositoryContextSkillOverrideInherit', 'Inherit'),
	on: localize('repositoryContextSkillOverrideOn', 'On'),
	off: localize('repositoryContextSkillOverrideOff', 'Off'),
};

export class SkillsViewPane extends ViewPane {

	private readonly renderedDisposables = this._register(new DisposableStore());
	private content: HTMLElement | undefined;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IContextSkillService private readonly skillService: IContextSkillService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService
		);
		this._register(this.skillService.onDidChange(snapshot => this.renderSnapshot(snapshot)));
	}

	override shouldShowWelcome(): boolean {
		return false;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.content = dom.append(container, dom.$('.repository-context-skills'));
		this.renderSnapshot(this.skillService.snapshot);
	}

	private renderSnapshot(snapshot: ISkillManagementSnapshot): void {
		if (!this.content) {
			return;
		}
		this.renderedDisposables.clear();
		dom.clearNode(this.content);

		this.renderContextHeader(snapshot);
		if (!snapshot.activeRepository) {
			this.renderEmptyState(localize(
				'repositoryContextSkillsNoActiveRepository',
				'Select a repository to see its effective Skills.'
			));
			return;
		}
		if (snapshot.loading) {
			this.renderEmptyState(localize('repositoryContextSkillsLoading', 'Loading Skills...'));
			return;
		}

		for (const error of snapshot.errors) {
			const errorElement = dom.append(this.content, dom.$('.repository-context-skills-error'));
			errorElement.textContent = error;
		}
		if (!snapshot.globalRepository) {
			this.renderGlobalRepositoryPrompt();
		}

		this.renderSection('enabled', snapshot.sections.enabled);
		this.renderSection('available', snapshot.sections.available);
		this.renderSection('needsAttention', snapshot.sections.needsAttention);
	}

	private renderContextHeader(snapshot: ISkillManagementSnapshot): void {
		const header = dom.append(this.content!, dom.$('.repository-context-skills-context'));
		const label = dom.append(header, dom.$('.repository-context-skills-context-label'));
		label.textContent = localize('repositoryContextSkillsActiveRepository', 'Active repository');
		const name = dom.append(header, dom.$('.repository-context-skills-context-name'));
		name.textContent = snapshot.activeRepository ? basename(snapshot.activeRepository) : localize('none', 'None');
		if (snapshot.activeRepository) {
			const path = dom.append(header, dom.$('.repository-context-skills-context-path'));
			path.textContent = snapshot.activeRepository.fsPath;
			path.title = snapshot.activeRepository.fsPath;
		}
	}

	private renderGlobalRepositoryPrompt(): void {
		const prompt = dom.append(this.content!, dom.$('.repository-context-skills-prompt'));
		const text = dom.append(prompt, dom.$('span'));
		text.textContent = localize(
			'repositoryContextSkillsNoGlobalRepository',
			'Global Skills are unavailable until a configuration repository is selected.'
		);
		const button = dom.append(prompt, dom.$<HTMLButtonElement>('button.repository-context-skills-link'));
		button.type = 'button';
		button.textContent = localize('repositoryContextSkillsChooseGlobalRepository', 'Choose repository');
		this.renderedDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			void this.commandService.executeCommand(MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID);
		}));
	}

	private renderSection(section: SkillSection, skills: readonly IEffectiveSkill[]): void {
		const sectionElement = dom.append(this.content!, dom.$(`section.repository-context-skills-section.${section}`));
		const heading = dom.append(sectionElement, dom.$('h3.repository-context-skills-section-title'));
		const headingText = dom.append(heading, dom.$('span'));
		headingText.textContent = sectionLabels[section];
		const count = dom.append(heading, dom.$('span.repository-context-skills-count'));
		count.textContent = String(skills.length);

		if (skills.length === 0) {
			const empty = dom.append(sectionElement, dom.$('.repository-context-skills-section-empty'));
			empty.textContent = localize('repositoryContextSkillsSectionEmpty', 'No Skills');
			return;
		}

		const list = dom.append(sectionElement, dom.$('.repository-context-skills-list'));
		list.setAttribute('role', 'list');
		list.setAttribute('aria-label', sectionLabels[section]);
		for (const skill of skills) {
			this.renderSkill(list, skill);
		}
	}

	private renderSkill(list: HTMLElement, skill: IEffectiveSkill): void {
		const row = dom.append(list, dom.$('.repository-context-skill-row'));
		row.setAttribute('role', 'listitem');
		row.dataset.skillId = skill.id;

		const summary = dom.append(row, dom.$('.repository-context-skill-summary'));
		const title = dom.append(summary, dom.$('.repository-context-skill-title'));
		title.textContent = skill.name;
		const origins = dom.append(summary, dom.$('.repository-context-skill-origins'));
		for (const origin of skill.origins) {
			const badge = dom.append(origins, dom.$(`span.repository-context-skill-origin.${origin}`));
			badge.textContent = originLabels[origin];
		}

		if (skill.description) {
			const description = dom.append(row, dom.$('.repository-context-skill-description'));
			description.textContent = skill.description;
		}
		if (skill.issue) {
			const issue = dom.append(row, dom.$('.repository-context-skill-issue'));
			issue.textContent = skill.issue;
		}

		const controls = dom.append(row, dom.$('.repository-context-skill-overrides'));
		controls.setAttribute('role', 'group');
		controls.setAttribute('aria-label', localize(
			'repositoryContextSkillOverrideLabel',
			'Repository override for {0}',
			skill.name
		));
		for (const override of ['inherit', 'on', 'off'] as const) {
			const button = dom.append(controls, dom.$<HTMLButtonElement>('button.repository-context-skill-override'));
			button.type = 'button';
			button.textContent = overrideLabels[override];
			button.disabled = skill.section === 'needsAttention';
			button.setAttribute('aria-pressed', String(skill.repositoryOverride === override));
			if (skill.repositoryOverride === override) {
				button.classList.add('selected');
			}
			this.renderedDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				void this.setOverride(skill, override);
			}));
		}

		const effective = dom.append(row, dom.$('.repository-context-skill-effective'));
		effective.textContent = this.getEffectiveLabel(skill);
	}

	private async setOverride(skill: IEffectiveSkill, override: SkillOverride): Promise<void> {
		try {
			await this.skillService.setRepositoryOverride(skill.id, override);
		} catch (error) {
			this.notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}

	private getEffectiveLabel(skill: IEffectiveSkill): string {
		if (skill.section === 'needsAttention') {
			return localize(
				'repositoryContextSkillUnavailableUntilResolved',
				'Unavailable until the issue is resolved'
			);
		}
		const activation = skill.activation === 'on'
			? localize('repositoryContextSkillEffectiveOn', 'Enabled')
			: localize('repositoryContextSkillEffectiveOff', 'Disabled');
		if (skill.activationSource === 'repository') {
			return localize('repositoryContextSkillEffectiveRepository', '{0} by repository override', activation);
		}
		if (skill.activationSource === 'global') {
			return localize('repositoryContextSkillEffectiveGlobal', '{0} by global default', activation);
		}
		return localize('repositoryContextSkillEffectiveDefault', '{0} by default', activation);
	}

	private renderEmptyState(message: string): void {
		const empty = dom.append(this.content!, dom.$('.repository-context-skills-empty'));
		empty.textContent = message;
	}
}
