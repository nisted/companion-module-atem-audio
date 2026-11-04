// atem-connection runs its network socket in a worker thread that it loads from its own files,
// and pulls in a native font library, so it can't be bundled: it's installed next to the module
// instead (the official ATEM module does the same).
module.exports = {
	externals: ['atem-connection'],
	forceRemoveNodeGypFromPkg: true,
}
