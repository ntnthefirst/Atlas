import { beforeEach, describe, expect, it } from "vitest";
import { LEGACY_STORAGE_KEY_RENAMES, migrateLegacyStorageKeys } from "./storageMigration";

// A minimal in-memory Storage, so these run in the node environment without
// pulling jsdom in for three key lookups.
class FakeStorage implements Storage {
	private map = new Map<string, string>();

	get length() {
		return this.map.size;
	}
	clear() {
		this.map.clear();
	}
	getItem(key: string) {
		return this.map.has(key) ? (this.map.get(key) as string) : null;
	}
	key(index: number) {
		return [...this.map.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.map.delete(key);
	}
	setItem(key: string, value: string) {
		this.map.set(key, value);
	}
}

const [ORDER_OLD, ORDER_NEW] = LEGACY_STORAGE_KEY_RENAMES[0];
const [COLUMNS_OLD, COLUMNS_NEW] = LEGACY_STORAGE_KEY_RENAMES[1];

let storage: FakeStorage;

beforeEach(() => {
	storage = new FakeStorage();
});

describe("migrateLegacyStorageKeys", () => {
	it("does nothing on a fresh install", () => {
		expect(migrateLegacyStorageKeys(storage)).toBe(0);
		expect(storage.length).toBe(0);
	});

	it("carries a legacy value across to the new key", () => {
		const columns = JSON.stringify({ "env-1": [{ status: "todo", label: "To do" }] });
		storage.setItem(COLUMNS_OLD, columns);

		expect(migrateLegacyStorageKeys(storage)).toBe(1);
		expect(storage.getItem(COLUMNS_NEW)).toBe(columns);
	});

	it("removes the legacy key once carried across", () => {
		storage.setItem(ORDER_OLD, "[]");
		migrateLegacyStorageKeys(storage);
		expect(storage.getItem(ORDER_OLD)).toBeNull();
	});

	it("migrates every renamed key in one pass", () => {
		for (const [legacy] of LEGACY_STORAGE_KEY_RENAMES) {
			storage.setItem(legacy, "\"value\"");
		}
		expect(migrateLegacyStorageKeys(storage)).toBe(LEGACY_STORAGE_KEY_RENAMES.length);
	});

	it("never overwrites a value already under the new key", () => {
		storage.setItem(COLUMNS_OLD, "\"stale\"");
		storage.setItem(COLUMNS_NEW, "\"current\"");

		migrateLegacyStorageKeys(storage);

		expect(storage.getItem(COLUMNS_NEW)).toBe("\"current\"");
		expect(storage.getItem(COLUMNS_OLD)).toBeNull();
	});

	it("is idempotent across repeated launches", () => {
		storage.setItem(COLUMNS_OLD, "\"value\"");

		expect(migrateLegacyStorageKeys(storage)).toBe(1);
		expect(migrateLegacyStorageKeys(storage)).toBe(0);
		expect(migrateLegacyStorageKeys(storage)).toBe(0);
		expect(storage.getItem(COLUMNS_NEW)).toBe("\"value\"");
	});

	it("preserves the value byte for byte, without reparsing it", () => {
		// The stored shape is opaque here; round-tripping through JSON would risk
		// changing it, so the migration must move the raw string.
		const raw = '{"env-1":["a","b"],"env-2":[]}';
		storage.setItem(ORDER_OLD, raw);
		migrateLegacyStorageKeys(storage);
		expect(storage.getItem(ORDER_NEW)).toBe(raw);
	});

	it("survives storage that throws", () => {
		const hostile = {
			getItem: () => {
				throw new Error("storage disabled");
			},
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		} as unknown as Storage;

		expect(() => migrateLegacyStorageKeys(hostile)).not.toThrow();
		expect(migrateLegacyStorageKeys(hostile)).toBe(0);
	});
});
