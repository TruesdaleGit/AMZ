"""Minimal .xlsx writer using only the standard library (one sheet, text and numbers)."""
import io
import zipfile
from xml.sax.saxutils import escape


def _column(index):
    name = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def _cell(ref, value, bold=False):
    style = ' s="1"' if bold else ""
    if isinstance(value, bool):
        value = int(value)
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"{style}><v>{value}</v></c>'
    if value is None or value == "":
        return ""
    # strip characters XML 1.0 does not allow
    text = "".join(ch for ch in str(value) if ch in "\t\n\r" or ord(ch) >= 32)
    return f'<c r="{ref}" t="inlineStr"{style}><is><t xml:space="preserve">{escape(text)}</t></is></c>'


def workbook(headers, rows, sheet_name="Sheet1"):
    """Return the bytes of an .xlsx file with a bold header row."""
    lines = ['<row r="1">' + "".join(_cell(f"{_column(i)}1", h, True) for i, h in enumerate(headers)) + "</row>"]
    for r, row in enumerate(rows, 2):
        lines.append(f'<row r="{r}">' + "".join(_cell(f"{_column(i)}{r}", v) for i, v in enumerate(row)) + "</row>")
    widths = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{min(max(len(str(h)) + 4, 12), 40)}" customWidth="1"/>'
                     for i, h in enumerate(headers))
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    pkg = "http://schemas.openxmlformats.org/package/2006"
    files = {
        "[Content_Types].xml": f'<Types xmlns="{pkg}/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '</Types>',
        "_rels/.rels": f'<Relationships xmlns="{pkg}/relationships">'
            f'<Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets>'
            f'<sheet name="{escape(sheet_name[:31])}" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{pkg}/relationships">'
            f'<Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/>'
            f'<Relationship Id="rId2" Type="{rel}/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": f'<styleSheet xmlns="{ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
            '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{ns}"><sheetViews><sheetView workbookViewId="0">'
            '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
            f'<cols>{widths}</cols><sheetData>{"".join(lines)}</sheetData></worksheet>',
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, body in files.items():
            archive.writestr(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body)
    return buffer.getvalue()
