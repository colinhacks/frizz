import type { Browser, LaunchOptions } from "puppeteer"

/** True for a Google Chrome installed on the machine, as opposed to a browser puppeteer downloaded. */
export function isInstalledChrome(executable: string): boolean

export function launchHeadless(
  options?: Omit<LaunchOptions, "executablePath" | "channel" | "headless"> & { colorScheme?: "dark" | "light" },
): Promise<Browser>
