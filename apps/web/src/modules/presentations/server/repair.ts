import {
  EMPTY_RELATIONSHIPS,
  encoder,
  fail,
  insertAfterClose,
  insertBeforeClose,
  localName,
  nextNumber,
  nextRelationshipId,
  parseXml,
  relationshipXml,
  relativeTarget,
  relsOf,
  type Parts,
} from "./package-xml.ts";

/**
 * Package fixes after Office Kit saves: what it drops, keeps or forgets that
 * PowerPoint needs. Each works on a parts map and reports the existing parts it
 * changed, so the preservation check can allow exactly those.
 */
const TYPES = "[Content_Types].xml";
const text = (parts: Parts, part: string) => new TextDecoder().decode(parts.get(part));
const put = (parts: Parts, part: string, value: string) => parts.set(part, encoder.encode(value));

/** Drops the content-type override of every part the package no longer has. */
const withoutMissingOverrides = (types: string, parts: Parts) =>
  types.replace(
    /<(?:[\w.-]+:)?Override\b[^>]*?\bPartName=(["'])\/([^"']+)\1[^>]*?(?:\/>|>\s*<\/(?:[\w.-]+:)?Override\s*>)/g,
    (entry, _quote, part: string) => (parts.has(part) ? entry : ""),
  );

const entriesOf = (types: string) =>
  [...parseXml(types).documentElement.children]
    .filter((item) => localName(item) === "Default" || localName(item) === "Override")
    .map((item) => ({
      key: item.getAttribute("PartName") ?? `.${item.getAttribute("Extension")?.toLowerCase()}`,
      type: item.getAttribute("ContentType"),
      xml: item.outerHTML,
    }));

/**
 * Office Kit rewrites the content types from what it understands, which loses
 * the SVG default. The previous serialization is kept, extended with entries
 * the edit added and trimmed of parts it removed. Reports whether it changed.
 */
export function preserveContentTypes(before: Parts, next: Parts) {
  if (![...before.keys()].some((part) => /^ppt\/media\/[^/]+\.svg$/i.test(part))) return false;
  const previous = text(before, TYPES);
  const current = text(next, TYPES);
  if (previous === current) return false;
  const known = new Map(entriesOf(previous).map((entry) => [entry.key, entry.type]));
  const additions: string[] = [];
  for (const entry of entriesOf(current)) {
    if (!known.has(entry.key)) additions.push(entry.xml.replace(/<(\/?)[\w.-]+:/g, "<$1"));
    else if (known.get(entry.key) !== entry.type)
      fail("preservation", `Content type changed for ${entry.key}.`);
  }
  let types = withoutMissingOverrides(previous, next);
  if (additions.length)
    types = insertBeforeClose(types, "Types", (prefix) =>
      additions
        .map((entry) => entry.replace(/<(\/?)(Default|Override)\b/g, `<$1${prefix}$2`))
        .join(""),
    );
  put(next, TYPES, types);
  return true;
}

/**
 * Office Kit keeps a removed slide's notes slide as an orphan and rewrites its
 * relationships; the notes belong to the slide, so they go with it.
 */
export function dropNotes(parts: Parts, notes: string) {
  parts.delete(notes);
  parts.delete(relsOf(notes));
  put(parts, TYPES, withoutMissingOverrides(text(parts, TYPES), parts));
}

const NOTES_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;

/**
 * Office Kit writes notes slides without the notes master PowerPoint requires.
 * Links every notes slide to one, creating it (with its own theme copy) when
 * the deck has none, and returns the existing parts that touched.
 */
export function ensureNotesMaster(parts: Parts) {
  const notes = [...parts.keys()].filter((name) => /^ppt\/notesSlides\/[^/]+\.xml$/.test(name));
  const changed: string[] = [];
  if (!notes.length) return changed;
  let master = [...parts.keys()].find((name) =>
    /^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(name),
  );
  if (!master) {
    master = "ppt/notesMasters/notesMaster1.xml";
    const themes = [...parts.keys()].filter((name) => /^ppt\/theme\/theme\d+\.xml$/.test(name));
    const theme = `ppt/theme/theme${nextNumber(themes, /theme(\d+)\.xml/g)}.xml`;
    parts.set(theme, parts.get(themes.toSorted()[0]!)!);
    put(parts, master, NOTES_MASTER);
    put(
      parts,
      relsOf(master),
      insertBeforeClose(EMPTY_RELATIONSHIPS, "Relationships", (prefix) =>
        relationshipXml(prefix, "rId1", "theme", relativeTarget(master!, theme)),
      ),
    );
    const presentationRels = text(parts, "ppt/_rels/presentation.xml.rels");
    const rId = nextRelationshipId(presentationRels);
    put(
      parts,
      "ppt/_rels/presentation.xml.rels",
      insertBeforeClose(presentationRels, "Relationships", (prefix) =>
        relationshipXml(
          prefix,
          rId,
          "notesMaster",
          relativeTarget("ppt/presentation.xml", master!),
        ),
      ),
    );
    const presentation = text(parts, "ppt/presentation.xml");
    if (/<(?:[\w.-]+:)?notesMasterIdLst\b/.test(presentation))
      fail("invalid_package", "The deck lists a notes master it does not contain.");
    put(
      parts,
      "ppt/presentation.xml",
      insertAfterClose(
        presentation,
        "sldMasterIdLst",
        (prefix) =>
          `<${prefix}notesMasterIdLst><${prefix}notesMasterId r:id="${rId}"/></${prefix}notesMasterIdLst>`,
      ),
    );
    put(
      parts,
      TYPES,
      insertBeforeClose(
        text(parts, TYPES),
        "Types",
        (prefix) =>
          `<${prefix}Override PartName="/${master}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><${prefix}Override PartName="/${theme}" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
      ),
    );
    changed.push("ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", TYPES);
  }
  for (const note of notes) {
    const name = relsOf(note);
    const rels = parts.has(name) ? text(parts, name) : EMPTY_RELATIONSHIPS;
    if (/relationships\/notesMaster["']/.test(rels)) continue;
    put(
      parts,
      name,
      insertBeforeClose(rels, "Relationships", (prefix) =>
        relationshipXml(
          prefix,
          nextRelationshipId(rels),
          "notesMaster",
          relativeTarget(note, master!),
        ),
      ),
    );
    changed.push(name);
  }
  return changed;
}
