/**
 * Minimal stub of the Obsidian API for unit tests.
 * Only the exports actually used by the source modules are included.
 */
export function normalizePath(p: string): string {
	return p
		.replace(/\\/g, '/')   // backslash → forward slash
		.replace(/^\/+/, '')    // no leading slash
		.replace(/\/+$/, '');   // no trailing slash
}

/** Platform stub — always simulates desktop in unit tests. */
export const Platform = {
	isMobile: false,
	isDesktop: true,
	isMobileApp: false,
	isDesktopApp: true,
	isIosApp: false,
	isAndroidApp: false,
};
