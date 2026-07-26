/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const REPOBUD_SKILL_PROJECTION_CHANNEL = 'repoBudSkillProjection';

export type SkillProjectionClient = 'codex' | 'claude-code' | 'cursor';
export type SkillProjectionMode = 'direct' | 'symlink' | 'managed-copy';
export type SkillProjectionState = 'missing' | 'linked' | 'copied' | 'modified' | 'outdated' | 'unsupported';
export type SkillProjectionStrategy = 'prefer-link' | 'managed-copy';

export interface ISkillProjectionManifest {
	readonly version: 1;
	readonly client: SkillProjectionClient;
	readonly skillId: string;
	readonly mode: 'managed-copy';
	readonly source: string;
	readonly target: string;
	readonly overlay?: string;
	readonly sourceHash: string;
	readonly outputHash: string;
}

export interface ISkillProjectionRequest {
	readonly client: SkillProjectionClient;
	readonly skillId: string;
	readonly source: URI;
	readonly target: URI;
	readonly overlay?: URI;
	readonly manifest?: ISkillProjectionManifest;
	readonly strategy?: SkillProjectionStrategy;
}

export interface ISkillProjectionResult {
	readonly state: SkillProjectionState;
	readonly mode?: SkillProjectionMode;
	readonly manifest?: ISkillProjectionManifest;
	readonly sourceHash?: string;
	readonly outputHash?: string;
	readonly detail?: string;
}

export const IRepoBudSkillProjectionService =
	createDecorator<IRepoBudSkillProjectionService>('repoBudSkillProjectionService');

export interface IRepoBudSkillProjectionService {
	readonly _serviceBrand: undefined;

	inspect(request: ISkillProjectionRequest): Promise<ISkillProjectionResult>;
	project(request: ISkillProjectionRequest): Promise<ISkillProjectionResult>;
	importChanges(request: ISkillProjectionRequest): Promise<ISkillProjectionResult>;
	restore(request: ISkillProjectionRequest): Promise<ISkillProjectionResult>;
}
