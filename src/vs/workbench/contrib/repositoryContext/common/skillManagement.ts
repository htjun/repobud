/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	SkillProjectionMode,
	SkillProjectionState,
} from '../../../../platform/repositoryContext/common/skillProjection.js';
import { CanonicalActivation, ICanonicalCapabilitySetting } from './canonicalConfiguration.js';

export const GLOBAL_SKILLS_DIRECTORY = 'skills';
export const REPOSITORY_SKILLS_DIRECTORY = 'skills';
export const SKILL_DEFINITION_FILE = 'SKILL.md';

export type SkillOrigin = 'global' | 'repository' | 'plugin';
export type SkillOverride = 'inherit' | CanonicalActivation;
export type SkillSection = 'enabled' | 'available' | 'needsAttention';
export type SkillActivationSource = 'default' | 'global' | 'repository';
export type SkillClient = 'codex';

export interface ISkillClientProjection {
	readonly client: SkillClient;
	readonly state: SkillProjectionState;
	readonly mode?: SkillProjectionMode;
	readonly target?: URI;
	readonly detail?: string;
}

export interface ICanonicalSkillDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly origin: SkillOrigin;
	readonly resource: URI;
	readonly issue?: string;
}

export interface IEffectiveSkill {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly origins: readonly SkillOrigin[];
	readonly activation: CanonicalActivation;
	readonly activationSource: SkillActivationSource;
	readonly repositoryOverride: SkillOverride;
	readonly section: SkillSection;
	readonly definitionResource?: URI;
	readonly projections: readonly ISkillClientProjection[];
	readonly issue?: string;
}

export interface IEffectiveSkillSections {
	readonly enabled: readonly IEffectiveSkill[];
	readonly available: readonly IEffectiveSkill[];
	readonly needsAttention: readonly IEffectiveSkill[];
}

export interface ISkillManagementSnapshot {
	readonly activeRepository: URI | undefined;
	readonly globalRepository: URI | undefined;
	readonly sections: IEffectiveSkillSections;
	readonly globalSkills: readonly IEffectiveSkill[];
	readonly errors: readonly string[];
	readonly loading: boolean;
}

export const IContextSkillService = createDecorator<IContextSkillService>('contextSkillService');

export interface IContextSkillService {
	readonly _serviceBrand: undefined;
	readonly snapshot: ISkillManagementSnapshot;
	readonly onDidChange: Event<ISkillManagementSnapshot>;

	refresh(): Promise<void>;
	setRepositoryOverride(skillId: string, override: SkillOverride): Promise<void>;
	setGlobalActivation(skillId: string, activation: CanonicalActivation): Promise<void>;
	projectToCodex(skillId: string): Promise<void>;
	importCodexChanges(skillId: string): Promise<void>;
	restoreCodexProjection(skillId: string): Promise<void>;
}

const originOrder: readonly SkillOrigin[] = ['repository', 'global', 'plugin'];

function compareSkills(left: IEffectiveSkill, right: IEffectiveSkill): number {
	return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function getActivation(
	id: string,
	globalSettings: Readonly<Record<string, ICanonicalCapabilitySetting>>,
	repositorySettings: Readonly<Record<string, ICanonicalCapabilitySetting>>,
): Pick<IEffectiveSkill, 'activation' | 'activationSource' | 'repositoryOverride'> {
	const repositorySetting = repositorySettings[id];
	if (repositorySetting) {
		return {
			activation: repositorySetting.activation,
			activationSource: 'repository',
			repositoryOverride: repositorySetting.activation,
		};
	}

	const globalSetting = globalSettings[id];
	return {
		activation: globalSetting?.activation ?? 'on',
		activationSource: globalSetting ? 'global' : 'default',
		repositoryOverride: 'inherit',
	};
}

export function resolveEffectiveSkills(
	definitions: readonly ICanonicalSkillDefinition[],
	globalSettings: Readonly<Record<string, ICanonicalCapabilitySetting>>,
	repositorySettings: Readonly<Record<string, ICanonicalCapabilitySetting>>,
): IEffectiveSkillSections {
	const definitionsById = new Map<string, ICanonicalSkillDefinition[]>();
	for (const definition of definitions) {
		const existing = definitionsById.get(definition.id) ?? [];
		existing.push(definition);
		definitionsById.set(definition.id, existing);
	}

	const ids = new Set([
		...definitionsById.keys(),
		...Object.keys(globalSettings),
		...Object.keys(repositorySettings),
	]);
	const sections: Record<SkillSection, IEffectiveSkill[]> = {
		enabled: [],
		available: [],
		needsAttention: [],
	};

	for (const id of ids) {
		const candidates = definitionsById.get(id) ?? [];
		const origins = [...new Set(candidates.map(candidate => candidate.origin))]
			.sort((left, right) => originOrder.indexOf(left) - originOrder.indexOf(right));
		if (origins.length === 0) {
			origins.push(repositorySettings[id] ? 'repository' : 'global');
		}

		const issues = candidates.flatMap(candidate => candidate.issue ? [candidate.issue] : []);
		if (candidates.length === 0) {
			issues.push(`No canonical definition exists for "${id}".`);
		} else if (candidates.length > 1) {
			issues.push(`Conflicting canonical definitions exist for "${id}".`);
		}

		const preferred = candidates.find(candidate => candidate.origin === 'repository') ?? candidates[0];
		const activation = getActivation(id, globalSettings, repositorySettings);
		let section: SkillSection;
		if (issues.length > 0) {
			section = 'needsAttention';
		} else if (activation.activation === 'on') {
			section = 'enabled';
		} else {
			section = 'available';
		}
		sections[section].push({
			id,
			name: preferred?.name ?? id,
			description: preferred?.description ?? '',
			origins,
			...activation,
			section,
			definitionResource: preferred?.resource,
			projections: [],
			issue: issues.length > 0 ? issues.join(' ') : undefined,
		});
	}

	return {
		enabled: sections.enabled.sort(compareSkills),
		available: sections.available.sort(compareSkills),
		needsAttention: sections.needsAttention.sort(compareSkills),
	};
}
