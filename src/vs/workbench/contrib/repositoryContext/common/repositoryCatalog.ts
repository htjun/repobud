/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IRepositoryCatalogService = createDecorator<IRepositoryCatalogService>('repositoryCatalogService');

export type RepositoryAvailability = 'ready' | 'missing' | 'notRepository';

export interface IRepositoryCatalogEntry {
	readonly uri: URI;
	readonly availability: RepositoryAvailability;
}

export interface IRepositoryCatalogService {
	readonly _serviceBrand: undefined;
	readonly entries: readonly IRepositoryCatalogEntry[];
	readonly activeRepository: URI | undefined;
	readonly onDidChange: Event<void>;

	add(uri: URI): Promise<IRepositoryCatalogEntry>;
	remove(uri: URI): void;
	refresh(): Promise<void>;
}

export async function getRepositoryAvailability(
	uri: URI,
	exists: (resource: URI) => Promise<boolean>,
): Promise<RepositoryAvailability> {
	if (!await exists(uri)) {
		return 'missing';
	}
	if (!await exists(joinPath(uri, '.git'))) {
		return 'notRepository';
	}
	return 'ready';
}

interface IStoredRepositoryCatalog {
	readonly version: 1;
	readonly repositories: readonly string[];
}

export class RepositoryCatalogModel {

	private readonly entriesByUri = new Map<string, IRepositoryCatalogEntry>();

	constructor(entries: readonly IRepositoryCatalogEntry[] = []) {
		for (const entry of entries) {
			this.entriesByUri.set(entry.uri.toString(), entry);
		}
	}

	get entries(): readonly IRepositoryCatalogEntry[] {
		return [...this.entriesByUri.values()];
	}

	add(entry: IRepositoryCatalogEntry): void {
		this.entriesByUri.set(entry.uri.toString(), entry);
	}

	remove(uri: URI): boolean {
		return this.entriesByUri.delete(uri.toString());
	}

	serialize(): string {
		const stored: IStoredRepositoryCatalog = {
			version: 1,
			repositories: this.entries.map(entry => entry.uri.toString()),
		};
		return JSON.stringify(stored);
	}

	static restore(raw: string | undefined): RepositoryCatalogModel {
		if (!raw) {
			return new RepositoryCatalogModel();
		}

		try {
			const stored = JSON.parse(raw) as Partial<IStoredRepositoryCatalog>;
			if (stored.version !== 1 || !Array.isArray(stored.repositories)) {
				return new RepositoryCatalogModel();
			}

			const entries: IRepositoryCatalogEntry[] = [];
			for (const value of stored.repositories) {
				if (typeof value !== 'string') {
					continue;
				}
				try {
					entries.push({ uri: URI.parse(value), availability: 'missing' });
				} catch {
					// Preserve valid catalog entries when one stored URI is malformed.
				}
			}
			return new RepositoryCatalogModel(entries);
		} catch {
			return new RepositoryCatalogModel();
		}
	}
}
