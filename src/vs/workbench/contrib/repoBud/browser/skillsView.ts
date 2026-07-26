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
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
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
	ISkillClientProjection,
	ISkillManagementSnapshot,
	SkillClient,
	SkillOrigin,
	SkillOverride,
	SkillSection,
} from '../common/skillManagement.js';
import { MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID } from './canonicalConfigurationActions.js';
import './media/skillsView.css';

const sectionLabels: Readonly<Record<SkillSection, string>> = {
	enabled: localize('repoBudSkillsEnabled', 'Enabled'),
	available: localize('repoBudSkillsAvailable', 'Available'),
	needsAttention: localize('repoBudSkillsNeedsAttention', 'Needs attention'),
};

const originLabels: Readonly<Record<SkillOrigin, string>> = {
	global: localize('repoBudSkillOriginGlobal', 'Global'),
	repository: localize('repoBudSkillOriginRepository', 'Repository'),
	plugin: localize('repoBudSkillOriginPlugin', 'Plugin'),
};

const overrideLabels: Readonly<Record<SkillOverride, string>> = {
	inherit: localize('repoBudSkillOverrideInherit', 'Inherit'),
	on: localize('repoBudSkillOverrideOn', 'On'),
	off: localize('repoBudSkillOverrideOff', 'Off'),
};

const projectionStateLabels: Readonly<Record<ISkillClientProjection['state'], string>> = {
	missing: localize('repoBudSkillProjectionMissing', 'Missing'),
	linked: localize('repoBudSkillProjectionLinked', 'Linked'),
	copied: localize('repoBudSkillProjectionCopied', 'Copied'),
	modified: localize('repoBudSkillProjectionModified', 'Modified'),
	outdated: localize('repoBudSkillProjectionOutdated', 'Outdated'),
	unsupported: localize('repoBudSkillProjectionUnsupported', 'Unsupported'),
};

const clientLabels: Readonly<Record<SkillClient, string>> = {
	codex: 'Codex',
	'claude-code': 'Claude Code',
	cursor: 'Cursor',
};

const compatibilityLabels: Readonly<Record<ISkillClientProjection['compatibility'], string>> = {
	compatible: localize('repoBudSkillCompatibilityCompatible', 'Compatible'),
	partial: localize('repoBudSkillCompatibilityPartial', 'Partial'),
	unsupported: localize('repoBudSkillCompatibilityUnsupported', 'Unsupported'),
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
		@IDialogService private readonly dialogService: IDialogService,
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
		this.content = dom.append(container, dom.$('.repobud-skills'));
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
				'repoBudSkillsNoActiveRepository',
				'Select a repository to see its effective Skills.'
			));
			return;
		}
		if (snapshot.loading) {
			this.renderEmptyState(localize('repoBudSkillsLoading', 'Loading Skills...'));
			return;
		}

		for (const error of snapshot.errors) {
			const errorElement = dom.append(this.content, dom.$('.repobud-skills-error'));
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
		const header = dom.append(this.content!, dom.$('.repobud-skills-context'));
		const label = dom.append(header, dom.$('.repobud-skills-context-label'));
		label.textContent = localize('repoBudSkillsActiveRepository', 'Active repository');
		const name = dom.append(header, dom.$('.repobud-skills-context-name'));
		name.textContent = snapshot.activeRepository ? basename(snapshot.activeRepository) : localize('none', 'None');
		if (snapshot.activeRepository) {
			const path = dom.append(header, dom.$('.repobud-skills-context-path'));
			path.textContent = snapshot.activeRepository.fsPath;
			path.title = snapshot.activeRepository.fsPath;
		}
	}

	private renderGlobalRepositoryPrompt(): void {
		const prompt = dom.append(this.content!, dom.$('.repobud-skills-prompt'));
		const text = dom.append(prompt, dom.$('span'));
		text.textContent = localize(
			'repoBudSkillsNoGlobalRepository',
			'Global Skills are unavailable until a configuration repository is selected.'
		);
		const button = dom.append(prompt, dom.$<HTMLButtonElement>('button.repobud-skills-link'));
		button.type = 'button';
		button.textContent = localize('repoBudSkillsChooseGlobalRepository', 'Choose repository');
		this.renderedDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			void this.commandService.executeCommand(MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID);
		}));
	}

	private renderSection(section: SkillSection, skills: readonly IEffectiveSkill[]): void {
		const sectionElement = dom.append(this.content!, dom.$(`section.repobud-skills-section.${section}`));
		const heading = dom.append(sectionElement, dom.$('h3.repobud-skills-section-title'));
		const headingText = dom.append(heading, dom.$('span'));
		headingText.textContent = sectionLabels[section];
		const count = dom.append(heading, dom.$('span.repobud-skills-count'));
		count.textContent = String(skills.length);

		if (skills.length === 0) {
			const empty = dom.append(sectionElement, dom.$('.repobud-skills-section-empty'));
			empty.textContent = localize('repoBudSkillsSectionEmpty', 'No Skills');
			return;
		}

		const list = dom.append(sectionElement, dom.$('.repobud-skills-list'));
		list.setAttribute('role', 'list');
		list.setAttribute('aria-label', sectionLabels[section]);
		for (const skill of skills) {
			this.renderSkill(list, skill);
		}
	}

	private renderSkill(list: HTMLElement, skill: IEffectiveSkill): void {
		const row = dom.append(list, dom.$('.repobud-skill-row'));
		row.setAttribute('role', 'listitem');
		row.dataset.skillId = skill.id;

		const summary = dom.append(row, dom.$('.repobud-skill-summary'));
		const title = dom.append(summary, dom.$('.repobud-skill-title'));
		title.textContent = skill.name;
		const origins = dom.append(summary, dom.$('.repobud-skill-origins'));
		for (const origin of skill.origins) {
			const badge = dom.append(origins, dom.$(`span.repobud-skill-origin.${origin}`));
			badge.textContent = originLabels[origin];
		}

		if (skill.description) {
			const description = dom.append(row, dom.$('.repobud-skill-description'));
			description.textContent = skill.description;
		}
		if (skill.issue) {
			const issue = dom.append(row, dom.$('.repobud-skill-issue'));
			issue.textContent = skill.issue;
		}
		this.renderClientProjections(row, skill);

		const controls = dom.append(row, dom.$('.repobud-skill-overrides'));
		controls.setAttribute('role', 'group');
		controls.setAttribute('aria-label', localize(
			'repoBudSkillOverrideLabel',
			'Repository override for {0}',
			skill.name
		));
		for (const override of ['inherit', 'on', 'off'] as const) {
			const button = dom.append(controls, dom.$<HTMLButtonElement>('button.repobud-skill-override'));
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

		const effective = dom.append(row, dom.$('.repobud-skill-effective'));
		effective.textContent = this.getEffectiveLabel(skill);
	}

	private renderClientProjections(row: HTMLElement, skill: IEffectiveSkill): void {
		const container = dom.append(row, dom.$('.repobud-skill-projection'));
		for (const projection of skill.projections) {
			this.renderClientProjection(container, skill, projection);
		}
	}

	private renderClientProjection(
		container: HTMLElement,
		skill: IEffectiveSkill,
		projection: ISkillClientProjection,
	): void {
		const client = dom.append(container, dom.$('.repobud-skill-client-row'));
		const badge = dom.append(
			client,
			dom.$(`span.repobud-skill-client.${projection.state}`)
		);
		badge.textContent = localize(
			'repoBudSkillProjectionBadge',
			'{0} · {1} · {2}',
			clientLabels[projection.client],
			compatibilityLabels[projection.compatibility],
			projectionStateLabels[projection.state]
		);
		const details = [projection.compatibilityReason, projection.detail].filter(Boolean);
		if (details.length > 0) {
			badge.title = details.join(' ');
		}

		const actions = dom.append(client, dom.$('.repobud-skill-projection-actions'));
		if (projection.state === 'missing' && skill.activation === 'on' && skill.section !== 'needsAttention') {
			this.renderProjectionAction(
				actions,
				localize('repoBudProjectSkillToCodex', 'Project'),
				() => this.runProjectionAction(() => this.skillService.project(skill.id, projection.client))
			);
		}
		if (projection.state === 'modified' && !projection.overlay) {
			this.renderProjectionAction(
				actions,
				localize('repoBudImportCodexSkillChanges', 'Import changes'),
				() => this.confirmImport(skill, projection.client)
			);
		}
		if (projection.state === 'modified' || projection.state === 'outdated') {
			this.renderProjectionAction(
				actions,
				localize('repoBudRestoreCodexSkillProjection', 'Restore projection'),
				() => this.confirmRestore(skill, projection.client)
			);
		}
	}

	private renderProjectionAction(
		container: HTMLElement,
		label: string,
		action: () => Promise<void>,
	): void {
		const button = dom.append(
			container,
			dom.$<HTMLButtonElement>('button.repobud-skill-projection-action')
		);
		button.type = 'button';
		button.textContent = label;
		this.renderedDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			void action();
		}));
	}

	private async confirmImport(skill: IEffectiveSkill, client: SkillClient): Promise<void> {
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localize(
				'repoBudConfirmImportCodexSkillChanges',
				'Import projected changes into the canonical Skill?'
			),
			detail: localize(
				'repoBudConfirmImportCodexSkillChangesDetail',
				'The external {0} copy will replace the canonical content for "{1}".',
				clientLabels[client],
				skill.name,
			),
			primaryButton: localize('repoBudImportChangesPrimaryButton', 'Import changes'),
		});
		if (result.confirmed) {
			await this.runProjectionAction(() => this.skillService.importChanges(skill.id, client));
		}
	}

	private async confirmRestore(skill: IEffectiveSkill, client: SkillClient): Promise<void> {
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localize(
				'repoBudConfirmRestoreCodexSkillProjection',
				'Restore the {0} projection from canonical content?',
				clientLabels[client],
			),
			detail: localize(
				'repoBudConfirmRestoreCodexSkillProjectionDetail',
				'External changes in the {0} target for "{1}" will be replaced.',
				clientLabels[client],
				skill.name,
			),
			primaryButton: localize('repoBudRestoreProjectionPrimaryButton', 'Restore projection'),
		});
		if (result.confirmed) {
			await this.runProjectionAction(() => this.skillService.restoreProjection(skill.id, client));
		}
	}

	private async runProjectionAction(action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			this.notificationService.error(error instanceof Error ? error.message : String(error));
		}
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
				'repoBudSkillUnavailableUntilResolved',
				'Unavailable until the issue is resolved'
			);
		}
		const activation = skill.activation === 'on'
			? localize('repoBudSkillEffectiveOn', 'Enabled')
			: localize('repoBudSkillEffectiveOff', 'Disabled');
		if (skill.activationSource === 'repository') {
			return localize('repoBudSkillEffectiveRepository', '{0} by repository override', activation);
		}
		if (skill.activationSource === 'global') {
			return localize('repoBudSkillEffectiveGlobal', '{0} by global default', activation);
		}
		if (skill.activationSource === 'plugin') {
			return localize('repoBudSkillEffectivePlugin', '{0} because its Plugin is disabled', activation);
		}
		return localize('repoBudSkillEffectiveDefault', '{0} by default', activation);
	}

	private renderEmptyState(message: string): void {
		const empty = dom.append(this.content!, dom.$('.repobud-skills-empty'));
		empty.textContent = message;
	}
}
