import {
  EMPTY_RELATIONSHIPS,
  encoder,
  insertBeforeClose,
  nextNumber,
  nextRelationshipId,
  partId,
  relationshipXml,
  relativeTarget,
  relsOf,
  type Parts,
} from "./package-xml.ts";

/**
 * The starting point for a new deck. Office Kit's blank package places its
 * master placeholders for 4:3 and ships three layouts, so a 16:9 deck made from
 * it put every title in the left three quarters of the slide. This rewrites
 * that geometry to PowerPoint's own 16:9 defaults and adds the layouts a model
 * reaches for. Only new decks pass through here; opened files are never touched.
 */
const decoder = new TextDecoder();
const read = (parts: Parts, name: string) => decoder.decode(parts.get(name));
const write = (parts: Parts, name: string, text: string) => parts.set(name, encoder.encode(text));

export const DEFAULT_THEME = {
  dark1: "#1F2937",
  light1: "#FFFFFF",
  dark2: "#1E3A5F",
  light2: "#E8EDF3",
  accent1: "#2563EB",
  accent2: "#F59E0B",
  accent3: "#10B981",
  accent4: "#EF4444",
  accent5: "#8B5CF6",
  accent6: "#06B6D4",
} as const;

const xfrm = (x: number, y: number, cx: number, cy: number) =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const namespaces =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const group =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const plain = '<a:lstStyle><a:lvl1pPr marL="0" indent="0"><a:buNone/></a:lvl1pPr></a:lstStyle>';
const placeholder = (
  id: number,
  name: string,
  ph: string,
  geometry: string,
  prompt: string,
  options: { anchor?: string; list?: string } = {},
) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${geometry}</p:spPr><p:txBody><a:bodyPr${options.anchor ? ` anchor="${options.anchor}"` : ""}/>${options.list ?? "<a:lstStyle/>"}<a:p><a:r><a:rPr lang="en-US"/><a:t>${prompt}</a:t></a:r></a:p></p:txBody></p:sp>`;
const layout = (type: string, name: string, shapes: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout ${namespaces} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${group}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const title = placeholder(
  2,
  "Title 1",
  '<p:ph type="title"/>',
  "",
  "Click to edit Master title style",
);

const layouts = [
  layout("titleOnly", "Title Only", title),
  layout(
    "secHead",
    "Section Header",
    placeholder(
      2,
      "Title 1",
      '<p:ph type="title"/>',
      xfrm(831850, 1709738, 10515600, 2852737),
      "Click to edit Master title style",
      { anchor: "b" },
    ) +
      placeholder(
        3,
        "Text Placeholder 2",
        '<p:ph type="body" idx="1"/>',
        xfrm(831850, 4589463, 10515600, 1500187),
        "Click to edit Master text styles",
        { list: plain },
      ),
  ),
  layout(
    "twoObj",
    "Two Content",
    title +
      placeholder(
        3,
        "Content Placeholder 2",
        '<p:ph sz="half" idx="1"/>',
        xfrm(838200, 1825625, 5181600, 4351338),
        "Click to edit Master text styles",
      ) +
      placeholder(
        4,
        "Content Placeholder 3",
        '<p:ph sz="half" idx="2"/>',
        xfrm(6172200, 1825625, 5181600, 4351338),
        "Click to edit Master text styles",
      ),
  ),
];
const smallerBody: Record<string, string> = {
  "3200": "2800",
  "2800": "2400",
  "2400": "2000",
  "2000": "1800",
};

export function applyDeckTemplate(parts: Parts) {
  const master = "ppt/slideMasters/slideMaster1.xml";
  const masterRels = relsOf(master);
  let masterXml = read(parts, master)
    .replace(
      /(<p:ph type="title"\/>.*?<a:xfrm>)<a:off[^>]*\/><a:ext[^>]*\/>/s,
      `$1<a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/>`,
    )
    .replace(
      /(<p:ph type="body" idx="1"\/>.*?<a:xfrm>)<a:off[^>]*\/><a:ext[^>]*\/>/s,
      `$1<a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/>`,
    )
    .replace(/(<p:titleStyle><a:lvl1pPr[^>]*?)algn="ctr"/, '$1algn="l"')
    .replace(/<p:bodyStyle>.*?<\/p:bodyStyle>/s, (body) =>
      body.replace(/sz="(\d+)"/g, (match, size: string) =>
        smallerBody[size] ? `sz="${smallerBody[size]}"` : match,
      ),
    );
  write(
    parts,
    "ppt/slideLayouts/slideLayout2.xml",
    layout(
      "title",
      "Title Slide",
      placeholder(
        2,
        "Title 1",
        '<p:ph type="ctrTitle"/>',
        xfrm(1524000, 1122363, 9144000, 2387600),
        "Click to edit Master title style",
        {
          anchor: "b",
          list: '<a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr></a:lstStyle>',
        },
      ) +
        placeholder(
          3,
          "Subtitle 2",
          '<p:ph type="subTitle" idx="1"/>',
          xfrm(1524000, 3602038, 9144000, 1655762),
          "Click to edit Master subtitle style",
          {
            list: '<a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle>',
          },
        ),
    ),
  );
  let rels = read(parts, masterRels);
  let types = read(parts, "[Content_Types].xml");
  let layoutId = nextNumber([masterXml], /<p:sldLayoutId id="(\d+)"/g);
  let file = nextNumber(parts.keys(), /slideLayout(\d+)\.xml/g);
  const ids: string[] = [];
  for (const xml of layouts) {
    const part = `ppt/slideLayouts/slideLayout${file++}.xml`;
    const rId = nextRelationshipId(rels);
    write(parts, part, xml);
    write(
      parts,
      relsOf(part),
      insertBeforeClose(EMPTY_RELATIONSHIPS, "Relationships", (prefix) =>
        relationshipXml(prefix, "rId1", "slideMaster", relativeTarget(part, master)),
      ),
    );
    rels = insertBeforeClose(rels, "Relationships", (prefix) =>
      relationshipXml(prefix, rId, "slideLayout", relativeTarget(master, part)),
    );
    types = insertBeforeClose(
      types,
      "Types",
      (prefix) =>
        `<${prefix}Override PartName="${partId(part)}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    );
    ids.push(`<p:sldLayoutId id="${layoutId++}" r:id="${rId}"/>`);
  }
  masterXml = insertBeforeClose(masterXml, "sldLayoutIdLst", () => ids.join(""));
  write(parts, master, masterXml);
  write(parts, masterRels, rels);
  write(parts, "[Content_Types].xml", types);
}
