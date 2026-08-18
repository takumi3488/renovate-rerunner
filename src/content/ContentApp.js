import { createMendApi } from "../mend/api.js";
import { parseMendLocation } from "../mend/location.js";
import { ext } from "../shared/runtime.js";
import createScanWidget from "./ScanWidget.js";

export default function createContentApp() {
	const api = createMendApi({ origin: location.origin });
	return createScanWidget({
		currentOrg: parseMendLocation(location.pathname),
		listOrgs: () => api.listOrgs(),
		listDisabledRepos: (input) => api.listDisabledRepos(input),
		triggerScan: (target) => api.triggerScan(target),
		listAliveRepoNames: (org) =>
			ext.runtime.sendMessage({ type: "githubAliveRepos", org }),
		openSettings: () => ext.runtime.sendMessage({ type: "openSidebar" }),
	});
}
