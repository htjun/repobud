/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { CanonicalActivation } from '../common/canonicalConfiguration.js';
import { IContextSkillService, IEffectiveSkill } from '../common/skillManagement.js';
import { REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS } from '../common/repositoryContext.js';
import { MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID } from './canonicalConfigurationActions.js';

export const MANAGE_GLOBAL_SKILL_LIBRARY_COMMAND_ID = 'repositoryContext.manageGlobalSkillLibrary';

interface IGlobalSkillQuickPickItem extends IQuickPickItem {
	readonly skill: IEffectiveSkill;
}

interface IGlobalActivationQuickPickItem extends IQuickPickItem {
	readonly activation: CanonicalActivation;
}

registerAction2(class ManageGlobalSkillLibraryAction extends Action2 {
	constructor() {
		super({
			id: MANAGE_GLOBAL_SKILL_LIBRARY_COMMAND_ID,
			title: localize2('repositoryContextManageGlobalSkillLibrary', 'Manage Global Skill Library...'),
			f1: false,
			menu: {
				id: MenuId.ViewContainerTitle,
				group: '1_configuration',
				order: 110,
				when: ContextKeyExpr.equals(
					'viewContainer',
					REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS.skills
				),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const skillService = accessor.get(IContextSkillService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);
		await skillService.refresh();

		if (!skillService.snapshot.globalRepository) {
			await commandService.executeCommand(MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID);
			return;
		}
		if (skillService.snapshot.globalSkills.length === 0) {
			notificationService.info(localize(
				'repositoryContextGlobalSkillLibraryEmpty',
				'Add Skills under the configuration repository skills directory to manage them here.'
			));
			return;
		}

		const pickedSkill = await quickInputService.pick<IGlobalSkillQuickPickItem>(
			skillService.snapshot.globalSkills.map(skill => ({
				label: skill.name,
				description: skill.activation === 'on'
					? localize('repositoryContextGlobalSkillEnabled', 'Enabled globally')
					: localize('repositoryContextGlobalSkillDisabled', 'Disabled globally'),
				detail: skill.issue ?? skill.description,
				skill,
			})),
			{
				title: localize('repositoryContextGlobalSkillLibraryTitle', 'Global Skill Library'),
				placeHolder: localize(
					'repositoryContextGlobalSkillLibraryPlaceholder',
					'Choose a Skill to change its global default'
				),
				matchOnDescription: true,
				matchOnDetail: true,
			}
		);
		if (!pickedSkill) {
			return;
		}

		const pickedActivation = await quickInputService.pick<IGlobalActivationQuickPickItem>([{
			label: `$(check) ${localize('repositoryContextEnableSkillGlobally', 'On')}`,
			description: localize('repositoryContextEnableSkillGloballyDescription', 'Enable by default in repositories.'),
			activation: 'on',
		}, {
			label: `$(circle-slash) ${localize('repositoryContextDisableSkillGlobally', 'Off')}`,
			description: localize('repositoryContextDisableSkillGloballyDescription', 'Keep available but disabled by default.'),
			activation: 'off',
		}], {
			title: pickedSkill.skill.name,
			placeHolder: localize('repositoryContextGlobalSkillActivationPlaceholder', 'Choose the global default'),
		});
		if (!pickedActivation) {
			return;
		}

		try {
			await skillService.setGlobalActivation(pickedSkill.skill.id, pickedActivation.activation);
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
});
