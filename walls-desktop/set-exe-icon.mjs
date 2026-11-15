import * as ResEdit from "resedit";
import * as PELibrary from "pe-library";
import fs from "fs";
const [exePath, icoPath] = process.argv.slice(2);
const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const gid = groups.length ? groups[0].id : 1, lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, lang, ico.icons.map(i => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
if (vi) {
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: "Live Walls Chart", ProductName: "Live Walls Chart", OriginalFilename: "Live Walls Chart.exe", CompanyName: "" });
  vi.outputToResourceEntries(res.entries);
}
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log("icon set");
