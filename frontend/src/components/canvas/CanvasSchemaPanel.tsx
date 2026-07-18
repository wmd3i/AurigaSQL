import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Database, GitBranch, Link2, Maximize2, Minimize2 } from "lucide-react";
import { bff } from "../../api/bff";
import { cn } from "../../lib/cn";
import { parseSchemaGraph, type SchemaGraph, type SchemaRelation } from "../../lib/schemaGraph";
import type { Conversation } from "../../state/types";
import { DbIcon, dbEngine } from "../icons/DbIcon";

const PANEL_W = 420;
const MIN_TABLE_W = 184;
const MAX_TABLE_W = 360;
const HEADER_H = 38;
const ROW_H = 40;
const COL_GAP = 64;
const ROW_GAP = 18;
const GRAPH_PADDING = 18;
const MAX_COLUMNS_SHOWN = 4;
const EXTRA_NON_REL_COLUMNS = 0;
const GRAPH_VIEWPORT_PADDING = 20;
const MIN_ZOOM_RATIO = 0.2;
const MAX_ZOOM_RATIO = 4.5;
const DEFAULT_FIT_BIAS = 1;
const ORTHO_LINE_STEP = 18;
const COLUMN_SPREAD_BONUS = 56;
const MIN_GRAPH_HEIGHT = 720;
const ROW_ANCHOR_INSET = 28;
const TABLE_SIDE_PADDING = 16;
const TABLE_NAME_FONT_SIZE = 13;
const COLUMN_NAME_FONT_SIZE = 11;
const FOOTER_FONT_SIZE = 10;
const GRAPH_DRAG_TOP_SLACK = 420;
const GRAPH_DRAG_BOTTOM_SLACK = 460;

type TableColumnView = {
  name: string;
  isForeignKey: boolean;
  isReferencedKey: boolean;
  relationHint?: string;
};

type PositionedTable = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: TableColumnView[];
  remainingColumns: number;
  relationCount: number;
};

type RelationPlacement = {
  relation: SchemaRelation;
  sourceFanIndex: number;
  targetFanIndex: number;
  sourceFanCount: number;
  targetFanCount: number;
};

type GraphViewport = {
  x: number;
  y: number;
  scale: number;
};

type GraphWheelLikeEvent = {
  clientX: number;
  clientY: number;
  deltaY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
};

function latestSchemaResult(conv: Conversation | null): string | null {
  if (!conv) return null;
  for (let i = conv.timeline.length - 1; i >= 0; i -= 1) {
    const event = conv.timeline[i];
    const isSchemaTool =
      event.kind === "tool_response" &&
      (event.name === "get_schema" || event.name === "list_postgres_tables" || event.name === "describe_postgres_table");
    if (isSchemaTool && event.response.trim()) {
      return event.response;
    }
  }
  return null;
}

function graphForDatabase(conversations: Conversation[], database: string, activeId: string | null): SchemaGraph | null {
  const active = conversations.find((conv) => conv.id === activeId) ?? null;
  const candidates = [
    active,
    ...conversations.filter((conv) => conv.database === database && conv.id !== activeId),
  ].filter((conv): conv is Conversation => conv !== null);

  for (const conv of candidates) {
    const schema = latestSchemaResult(conv);
    if (!schema) continue;
    const graph = parseSchemaGraph(schema);
    if (graph) return graph;
  }
  return null;
}

function relationMeta(graph: SchemaGraph) {
  const meta = new Map<
    string,
    {
      isForeignKey: boolean;
      isReferencedKey: boolean;
      references: string[];
      referencedBy: string[];
    }
  >();
  graph.relations.forEach((relation) => {
    const fkKey = `${relation.fromTable}:${relation.fromColumn}`;
    const pkKey = `${relation.toTable}:${relation.toColumn}`;
    const fkMeta = meta.get(fkKey) ?? {
      isForeignKey: false,
      isReferencedKey: false,
      references: [],
      referencedBy: [],
    };
    const pkMeta = meta.get(pkKey) ?? {
      isForeignKey: false,
      isReferencedKey: false,
      references: [],
      referencedBy: [],
    };
    meta.set(fkKey, {
      isForeignKey: true,
      isReferencedKey: fkMeta.isReferencedKey,
      references: [...fkMeta.references, `${relation.toTable}.${relation.toColumn}`],
      referencedBy: fkMeta.referencedBy,
    });
    meta.set(pkKey, {
      isForeignKey: pkMeta.isForeignKey,
      isReferencedKey: true,
      references: pkMeta.references,
      referencedBy: [...pkMeta.referencedBy, `${relation.fromTable}.${relation.fromColumn}`],
    });
  });
  return meta;
}

function visibleColumns(
  table: SchemaGraph["tables"][number],
  columnMeta: Map<
    string,
    {
      isForeignKey: boolean;
      isReferencedKey: boolean;
      references: string[];
      referencedBy: string[];
    }
  >,
  expanded: boolean,
) {
  if (expanded) {
    return {
      columns: table.columns.map((column) => {
        const meta = columnMeta.get(`${table.name}:${column.name}`);
        return {
          name: column.name,
          isForeignKey: meta?.isForeignKey ?? false,
          isReferencedKey: meta?.isReferencedKey ?? false,
        };
      }),
      remainingColumns: 0,
    };
  }

  const relationColumns = table.columns.filter((column) => columnMeta.has(`${table.name}:${column.name}`));
  const extraColumns = table.columns
    .filter((column) => !columnMeta.has(`${table.name}:${column.name}`))
    .slice(0, relationColumns.length === 0 ? EXTRA_NON_REL_COLUMNS : 0);

  const chosen = [...relationColumns, ...extraColumns]
    .slice(0, MAX_COLUMNS_SHOWN)
    .map((column) => {
      const meta = columnMeta.get(`${table.name}:${column.name}`);
      return {
        name: column.name,
        isForeignKey: meta?.isForeignKey ?? false,
        isReferencedKey: meta?.isReferencedKey ?? false,
      };
    });

  return {
    columns: chosen,
    remainingColumns: Math.max(0, table.columns.length - chosen.length),
  };
}

function buildDepthMap(graph: SchemaGraph) {
  const tableMap = new Map(graph.tables.map((table) => [table.name, table]));
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const parentCounts = new Map<string, number>();

  graph.tables.forEach((table) => {
    parents.set(table.name, new Set());
    children.set(table.name, new Set());
    parentCounts.set(table.name, 0);
  });

  graph.relations.forEach((relation) => {
    if (!tableMap.has(relation.toTable) || !tableMap.has(relation.fromTable)) return;
    children.get(relation.toTable)?.add(relation.fromTable);
    parents.get(relation.fromTable)?.add(relation.toTable);
  });

  graph.tables.forEach((table) => {
    parentCounts.set(table.name, parents.get(table.name)?.size ?? 0);
  });

  const roots = graph.tables
    .map((table) => table.name)
    .filter((name) => (parentCounts.get(name) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));
  const queue = roots.length > 0 ? [...roots] : graph.tables.map((table) => table.name).sort((a, b) => a.localeCompare(b));
  const depth = new Map<string, number>();

  queue.forEach((name) => depth.set(name, 0));

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depth.get(current) ?? 0;
    [...(children.get(current) ?? [])]
      .sort((a, b) => a.localeCompare(b))
      .forEach((child) => {
        const nextDepth = currentDepth + 1;
        if ((depth.get(child) ?? -1) < nextDepth) depth.set(child, nextDepth);
        if (!queue.includes(child)) queue.push(child);
      });
  }

  graph.tables.forEach((table) => {
    if (!depth.has(table.name)) depth.set(table.name, 0);
  });

  return depth;
}

function estimateTextWidth(text: string, fontSize: number, weight: "regular" | "medium" | "semibold" = "regular") {
  const weightFactor = weight === "semibold" ? 0.66 : weight === "medium" ? 0.64 : 0.6;
  return text.length * fontSize * weightFactor;
}

function tableWidthForContent(
  tableName: string,
  columns: TableColumnView[],
  remainingColumns: number,
  expanded: boolean,
) {
  const titleWidth = estimateTextWidth(tableName, TABLE_NAME_FONT_SIZE, "semibold") + TABLE_SIDE_PADDING * 2;
  const footerLabel = remainingColumns > 0 ? "Show all columns" : expanded ? "Show fewer columns" : "";
  const footerWidth = footerLabel
    ? estimateTextWidth(footerLabel, FOOTER_FONT_SIZE, "medium") + TABLE_SIDE_PADDING * 2
    : 0;
  const columnWidths = columns.map((column) => {
    const dotWidth = 18;
    const badgeWidth = column.isForeignKey || column.isReferencedKey ? 46 : 0;
    const gapWidth = column.isForeignKey || column.isReferencedKey ? 12 : 0;
    const textWidth = estimateTextWidth(column.name, COLUMN_NAME_FONT_SIZE, "medium");
    return TABLE_SIDE_PADDING * 2 + dotWidth + textWidth + badgeWidth + gapWidth;
  });

  return Math.max(
    MIN_TABLE_W,
    Math.min(MAX_TABLE_W, Math.ceil(Math.max(titleWidth, footerWidth, ...columnWidths, 0))),
  );
}

function layoutGraph(graph: SchemaGraph, expandedTables: Set<string>) {
  const columnMeta = relationMeta(graph);
  const depth = buildDepthMap(graph);
  const relationCounts = new Map<string, number>();

  graph.relations.forEach((relation) => {
    relationCounts.set(relation.fromTable, (relationCounts.get(relation.fromTable) ?? 0) + 1);
    relationCounts.set(relation.toTable, (relationCounts.get(relation.toTable) ?? 0) + 1);
  });

  const byDepth = new Map<number, string[]>();
  [...depth.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .forEach(([name, level]) => {
      const current = byDepth.get(level) ?? [];
      current.push(name);
      byDepth.set(level, current);
    });

  const drafts = new Map<
    string,
    { name: string; width: number; height: number; columns: TableColumnView[]; remainingColumns: number; relationCount: number }
  >();

  graph.tables.forEach((table) => {
    const { columns, remainingColumns } = visibleColumns(table, columnMeta, expandedTables.has(table.name));
    const relationCount = relationCounts.get(table.name) ?? 0;
    const footerRows = remainingColumns > 0 || expandedTables.has(table.name) ? 1 : 0;
    const height = HEADER_H + columns.length * ROW_H + footerRows * 26 + 14;
    const width = tableWidthForContent(table.name, columns, remainingColumns, expandedTables.has(table.name));
    drafts.set(table.name, {
      name: table.name,
      width,
      height,
      columns,
      remainingColumns,
      relationCount,
    });
  });

  const orderedDepths = [...byDepth.keys()].sort((a, b) => a - b);
  const columnHeights = orderedDepths.map((level) => {
    const names = (byDepth.get(level) ?? []).sort((a, b) => {
      const relationDelta = (relationCounts.get(b) ?? 0) - (relationCounts.get(a) ?? 0);
      if (relationDelta !== 0) return relationDelta;
      return a.localeCompare(b);
    });
    const baseHeight = names.reduce(
      (sum, name, index) => sum + (drafts.get(name)?.height ?? 0) + (index > 0 ? ROW_GAP : 0),
      0,
    );
    return names.length >= 4 ? baseHeight + (names.length - 1) * COLUMN_SPREAD_BONUS : baseHeight;
  });

  const graphHeight = Math.max(MIN_GRAPH_HEIGHT, ...columnHeights) + GRAPH_PADDING * 2;
  const positionedTables = new Map<string, PositionedTable>();
  const relationsByChild = new Map<string, SchemaRelation[]>();
  const columnWidths = new Map<number, number>();

  graph.relations.forEach((relation) => {
    const current = relationsByChild.get(relation.fromTable) ?? [];
    current.push(relation);
    relationsByChild.set(relation.fromTable, current);
  });

  orderedDepths.forEach((level) => {
    const names = byDepth.get(level) ?? [];
    columnWidths.set(
      level,
      names.reduce((max, name) => Math.max(max, drafts.get(name)?.width ?? MIN_TABLE_W), MIN_TABLE_W),
    );
  });

  const columnX = new Map<number, number>();
  let nextColumnX = GRAPH_PADDING;
  orderedDepths.forEach((level, index) => {
    columnX.set(level, nextColumnX);
    nextColumnX += (columnWidths.get(level) ?? MIN_TABLE_W) + (index < orderedDepths.length - 1 ? COL_GAP : 0);
  });

  orderedDepths.forEach((level, columnIndex) => {
    const names = (byDepth.get(level) ?? []).sort((a, b) => {
      const relationDelta = (relationCounts.get(b) ?? 0) - (relationCounts.get(a) ?? 0);
      if (relationDelta !== 0) return relationDelta;
      return a.localeCompare(b);
    });
    const totalHeight = names.reduce(
      (sum, name, index) => sum + (drafts.get(name)?.height ?? 0) + (index > 0 ? ROW_GAP : 0),
      0,
    );
    const x = columnX.get(level) ?? GRAPH_PADDING;
    const centeredStartY = GRAPH_PADDING + (graphHeight - GRAPH_PADDING * 2 - totalHeight) / 2;

    if (columnIndex === 0) {
      let cursorY = centeredStartY;
      names.forEach((name) => {
        const draft = drafts.get(name)!;
        positionedTables.set(name, {
          ...draft,
          x,
          y: cursorY,
        });
        cursorY += draft.height + ROW_GAP;
      });
      return;
    }

    const desiredOrder = names
      .map((name, index) => {
        const draft = drafts.get(name)!;
        const relations = relationsByChild.get(name) ?? [];
        const alignedTargets = relations
          .map((relation) => {
            const parent = positionedTables.get(relation.toTable);
            if (!parent) return null;
            return parent.y + columnCenterOffset(parent.columns, relation.toColumn) - columnCenterOffset(draft.columns, relation.fromColumn);
          })
          .filter((value): value is number => value !== null);

        const desiredY =
          alignedTargets.length > 0
            ? alignedTargets.reduce((sum, value) => sum + value, 0) / alignedTargets.length
            : centeredStartY + index * (draft.height + ROW_GAP);

        return { name, draft, desiredY };
      })
      .sort((a, b) => a.desiredY - b.desiredY || a.name.localeCompare(b.name));

    let cursorY = GRAPH_PADDING;
    desiredOrder.forEach((item) => {
      const y = Math.max(item.desiredY, cursorY);
      positionedTables.set(item.name, {
        ...item.draft,
        x,
        y,
      });
      cursorY = y + item.draft.height + ROW_GAP;
    });

    const columnBottom = desiredOrder.reduce((max, item) => {
      const table = positionedTables.get(item.name)!;
      return Math.max(max, table.y + table.height);
    }, 0);
    const currentTop = desiredOrder.reduce((min, item) => {
      const table = positionedTables.get(item.name)!;
      return Math.min(min, table.y);
    }, Number.POSITIVE_INFINITY);
    const overflow = Math.max(0, columnBottom - (graphHeight - GRAPH_PADDING));
    const upwardShift = Math.min(overflow, Math.max(0, currentTop - GRAPH_PADDING));

    if (upwardShift > 0) {
      desiredOrder.forEach((item) => {
        const table = positionedTables.get(item.name)!;
        positionedTables.set(item.name, {
          ...table,
          y: table.y - upwardShift,
        });
      });
    }

    if (desiredOrder.length >= 4) {
      let compactY = GRAPH_PADDING;
      desiredOrder.forEach((item) => {
        const table = positionedTables.get(item.name)!;
        positionedTables.set(item.name, {
          ...table,
          y: compactY,
        });
        compactY += item.draft.height + ROW_GAP;
      });
    }
  });

  const width =
    nextColumnX + GRAPH_PADDING;

  return { positionedTables, width: Math.max(PANEL_W - 48, width), height: graphHeight, columnMeta };
}

function columnY(table: PositionedTable, columnName: string) {
  const index = table.columns.findIndex((column) => column.name === columnName);
  if (index === -1) return table.y + HEADER_H + 12;
  return table.y + HEADER_H + index * ROW_H + ROW_H / 2;
}

function columnCenterOffset(columns: TableColumnView[], columnName: string) {
  const index = columns.findIndex((column) => column.name === columnName);
  if (index === -1) return HEADER_H + 12;
  return HEADER_H + index * ROW_H + ROW_H / 2;
}

function relationTitle(relation: SchemaRelation) {
  return `${relation.fromTable} links to ${relation.toTable}`;
}

function relationDescription(relation: SchemaRelation) {
  return `Match ${relation.fromTable}.${relation.fromColumn} with ${relation.toTable}.${relation.toColumn}`;
}

function buildRelationPlacements(relations: SchemaRelation[]) {
  const sourceGroups = new Map<string, SchemaRelation[]>();
  const targetGroups = new Map<string, SchemaRelation[]>();

  relations.forEach((relation) => {
    const sourceKey = `${relation.toTable}:${relation.toColumn}`;
    const targetKey = `${relation.fromTable}:${relation.fromColumn}`;
    const sourceItems = sourceGroups.get(sourceKey) ?? [];
    sourceItems.push(relation);
    sourceGroups.set(sourceKey, sourceItems);
    const targetItems = targetGroups.get(targetKey) ?? [];
    targetItems.push(relation);
    targetGroups.set(targetKey, targetItems);
  });

  return relations.map((relation) => {
    const sourceKey = `${relation.toTable}:${relation.toColumn}`;
    const targetKey = `${relation.fromTable}:${relation.fromColumn}`;
    const sourceItems = sourceGroups.get(sourceKey) ?? [relation];
    const targetItems = targetGroups.get(targetKey) ?? [relation];
    return {
      relation,
      sourceFanIndex: sourceItems.findIndex((item) => item === relation),
      targetFanIndex: targetItems.findIndex((item) => item === relation),
      sourceFanCount: sourceItems.length,
      targetFanCount: targetItems.length,
    } satisfies RelationPlacement;
  });
}

function columnAnchorX(table: PositionedTable, column: TableColumnView) {
  return column.isReferencedKey ? table.x + table.width - ROW_ANCHOR_INSET : table.x + ROW_ANCHOR_INSET;
}

function fanOffset(index: number, count: number) {
  if (count <= 1) return 0;
  return (index - (count - 1) / 2) * 20;
}

function relationPath(startX: number, startY: number, endX: number, endY: number, laneOffset: number) {
  const forward = endX >= startX;
  const startStubX = startX + (forward ? ORTHO_LINE_STEP : -ORTHO_LINE_STEP);
  const endStubX = endX + (forward ? -ORTHO_LINE_STEP : ORTHO_LINE_STEP);
  const midXBase = forward
    ? startStubX + (endStubX - startStubX) / 2
    : Math.max(startX, endX) + ORTHO_LINE_STEP * 1.6;
  const midX = midXBase + laneOffset * 0.45;

  return `M ${startX} ${startY} H ${startStubX} H ${midX} V ${endY} H ${endStubX} H ${endX}`;
}

function clampViewport(
  next: GraphViewport,
  layout: { width: number; height: number } | null,
  viewportSize: { width: number; height: number },
) {
  if (!layout || viewportSize.width === 0 || viewportSize.height === 0) return next;

  const contentWidth = layout.width * next.scale;
  const contentHeight = layout.height * next.scale;
  const visibleMarginX = Math.min(120, Math.max(48, viewportSize.width * 0.18));
  const visibleMarginY = Math.min(120, Math.max(48, viewportSize.height * 0.18));
  const smallContentPanSlackX = Math.min(180, Math.max(64, viewportSize.width * 0.16));
  const smallContentPanSlackTop = Math.max(GRAPH_DRAG_TOP_SLACK, viewportSize.height * 0.12);
  const smallContentPanSlackBottom = Math.max(GRAPH_DRAG_BOTTOM_SLACK, viewportSize.height * 0.24);

  const x =
    contentWidth <= viewportSize.width - visibleMarginX * 2
      ? Math.min(
          (viewportSize.width - contentWidth) / 2 + smallContentPanSlackX,
          Math.max((viewportSize.width - contentWidth) / 2 - smallContentPanSlackX, next.x),
        )
      : Math.min(visibleMarginX, Math.max(viewportSize.width - contentWidth - visibleMarginX, next.x));
  const y =
    contentHeight <= viewportSize.height - visibleMarginY * 2
      ? Math.min(
          (viewportSize.height - contentHeight) / 2 + smallContentPanSlackBottom,
          Math.max((viewportSize.height - contentHeight) / 2 - smallContentPanSlackTop, next.y),
        )
      : Math.min(
          Math.max(visibleMarginY, GRAPH_DRAG_BOTTOM_SLACK),
          Math.max(viewportSize.height - contentHeight - Math.max(visibleMarginY, GRAPH_DRAG_TOP_SLACK), next.y),
        );

  return {
    ...next,
    x,
    y,
  };
}

function sameViewport(a: GraphViewport, b: GraphViewport) {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.scale - b.scale) < 0.001;
}

function fittedViewport(
  layout: { width: number; height: number },
  viewportSize: { width: number; height: number },
  scale: number,
) {
  const contentWidth = layout.width * scale;
  const contentHeight = layout.height * scale;

  return clampViewport(
    {
      scale,
      x: (viewportSize.width - contentWidth) / 2,
      y: (viewportSize.height - contentHeight) / 2,
    },
    layout,
    viewportSize,
  );
}

export function CanvasSchemaPanel(props: {
  canvasDb: string;
  conversations: Conversation[];
  activeId: string | null;
  panelWidth?: number;
}) {
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [draggingGraph, setDraggingGraph] = useState(false);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [relationsOpen, setRelationsOpen] = useState(false);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [schemaText, setSchemaText] = useState<string | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const graphViewportRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(
    null,
  );
  const autoFitSignatureRef = useRef<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const timelineGraph = useMemo(
    () => graphForDatabase(props.conversations, props.canvasDb, props.activeId),
    [props.activeId, props.canvasDb, props.conversations],
  );
  const apiGraph = useMemo(() => (schemaText ? parseSchemaGraph(schemaText) : null), [schemaText]);
  const graph = apiGraph ?? timelineGraph;
  const layout = useMemo(() => (graph ? layoutGraph(graph, expandedTables) : null), [expandedTables, graph]);
  const allTablesExpanded = useMemo(() => {
    if (!graph || graph.tables.length === 0) return false;
    return graph.tables.every((table) => expandedTables.has(table.name));
  }, [expandedTables, graph]);
  const relations = useMemo(
    () =>
      graph
        ? [...graph.relations].sort(
            (a, b) =>
              a.toTable.localeCompare(b.toTable) ||
              a.fromTable.localeCompare(b.fromTable) ||
              a.fromColumn.localeCompare(b.fromColumn),
          )
        : [],
    [graph],
  );
  const relationPlacements = useMemo(() => buildRelationPlacements(relations), [relations]);

  useEffect(() => {
    let cancelled = false;
    setSchemaLoading(true);
    setSchemaText(null);

    bff
      .databaseSchema(props.canvasDb)
      .then((response) => {
        if (cancelled) return;
        setSchemaText(response.schema);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn(`Failed to load schema for ${props.canvasDb}`, error);
        setSchemaText(null);
      })
      .finally(() => {
        if (cancelled) return;
        setSchemaLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [props.canvasDb]);

  const fitScale = useMemo(() => {
    if (!layout || viewportSize.width === 0 || viewportSize.height === 0) return 1;
    const availableWidth = Math.max(120, viewportSize.width - GRAPH_VIEWPORT_PADDING * 2);
    const availableHeight = Math.max(120, viewportSize.height - GRAPH_VIEWPORT_PADDING * 2);
    const base = Math.min(1, availableWidth / layout.width, availableHeight / layout.height);
    return Math.min(1, base * DEFAULT_FIT_BIAS);
  }, [layout, viewportSize.height, viewportSize.width]);

  function resetGraphView() {
    if (!layout || viewportSize.width === 0 || viewportSize.height === 0) return;
    setViewport(fittedViewport(layout, viewportSize, fitScale));
  }

  function handleGraphMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (!layout) return;
    event.preventDefault();
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
      moved: false,
    };
    setDraggingGraph(true);
  }

  function stopGraphDrag() {
    dragStateRef.current = null;
    setDraggingGraph(false);
  }

  function triggerGraphReset() {
    stopGraphDrag();
    resetGraphView();
  }

  function handleGraphDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    triggerGraphReset();
  }

  useEffect(() => {
    const el = graphViewportRef.current;
    if (!el) return;
    const emit = () => setViewportSize({ width: el.clientWidth, height: el.clientHeight });
    emit();
    const ro = new ResizeObserver(emit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [graphExpanded]);

  useEffect(() => {
    if (!layout || !graph || viewportSize.width === 0 || viewportSize.height === 0) return;

    const signature = [
      graphExpanded ? "expanded" : "inline",
      props.canvasDb,
      props.activeId ?? "",
      layout.width,
      layout.height,
      viewportSize.width,
      viewportSize.height,
      expandedTables.size,
      graph.tables.map((table) => table.name).join("|"),
      [...expandedTables].sort().join("|"),
    ].join("::");

    if (autoFitSignatureRef.current === signature) return;
    autoFitSignatureRef.current = signature;
    resetGraphView();
  }, [
    expandedTables,
    fitScale,
    graph,
    graphExpanded,
    layout,
    props.activeId,
    props.canvasDb,
    viewportSize.height,
    viewportSize.width,
  ]);

  useEffect(() => {
    if (!layout || viewportSize.width === 0 || viewportSize.height === 0) return;
    setViewport((current) => {
      const clamped = clampViewport(current, layout, viewportSize);
      return sameViewport(current, clamped) ? current : clamped;
    });
  }, [layout, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    if (!graphExpanded) return;

    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setGraphExpanded(false);
      }
    }

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [graphExpanded]);

  useEffect(() => {
    setExpandedTables(new Set());
  }, [props.canvasDb]);

  function handleGraphWheel(event: GraphWheelLikeEvent) {
    if (!layout || !graphViewportRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = graphViewportRef.current.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const minScale = fitScale * MIN_ZOOM_RATIO;
    const maxScale = Math.max(6, fitScale * MAX_ZOOM_RATIO);

    setViewport((current) => {
      const zoomMultiplier = Math.exp(-event.deltaY * 0.0015);
      const nextScale = Math.min(maxScale, Math.max(minScale, current.scale * zoomMultiplier));
      const worldX = (cursorX - current.x) / current.scale;
      const worldY = (cursorY - current.y) / current.scale;
      const next = clampViewport({
        scale: nextScale,
        x: cursorX - worldX * nextScale,
        y: cursorY - worldY * nextScale,
      }, layout, viewportSize);
      return sameViewport(current, next) ? current : next;
    });
  }

  function toggleExpandedTable(tableName: string) {
    setExpandedTables((current) => {
      const next = new Set(current);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  }

  function toggleAllExpandedTables() {
    if (!graph) return;
    setExpandedTables((current) => {
      const shouldExpandAll = graph.tables.some((table) => !current.has(table.name));
      if (!shouldExpandAll) return new Set<string>();
      return new Set(graph.tables.map((table) => table.name));
    });
  }

  useEffect(() => {
    const el = graphViewportRef.current;
    if (!el || !layout) return;

    function handleNativeWheel(event: WheelEvent) {
      handleGraphWheel(event);
    }

    function handleNativeDoubleClick(event: MouseEvent) {
      event.preventDefault();
      event.stopPropagation();
      triggerGraphReset();
    }

    el.addEventListener("wheel", handleNativeWheel, { passive: false });
    el.addEventListener("dblclick", handleNativeDoubleClick);
    return () => {
      el.removeEventListener("wheel", handleNativeWheel);
      el.removeEventListener("dblclick", handleNativeDoubleClick);
    };
  }, [fitScale, graphExpanded, layout, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    if (!draggingGraph) return;

    function handleWindowMouseMove(event: MouseEvent) {
      const dragState = dragStateRef.current;
      if (!dragState) return;
      event.preventDefault();
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        dragState.moved = true;
      }
      setViewport((current) => {
        const next = clampViewport(
          {
            ...current,
            x: dragState.originX + dx,
            y: dragState.originY + dy,
          },
          layout,
          viewportSize,
        );
        return sameViewport(current, next) ? current : next;
      });
    }

    function handleWindowMouseUp() {
      stopGraphDrag();
    }

    function handleWindowBlur() {
      stopGraphDrag();
    }

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [draggingGraph, layout, viewportSize]);

  function renderGraphCanvas(expanded: boolean) {
    if (!layout) return null;

    return (
      <div
        ref={graphViewportRef}
        className={cn(
          "no-scrollbar relative overflow-hidden rounded-[24px] border border-line/70 bg-card/80 p-3",
          expanded ? "min-h-0 flex-1" : "h-[620px] min-h-[620px] md:h-[860px] md:min-h-[860px]",
          draggingGraph ? "cursor-grabbing select-none" : "cursor-grab",
        )}
        onMouseDown={handleGraphMouseDown}
        onDoubleClick={handleGraphDoubleClick}
        style={{
          overscrollBehavior: "contain",
          overscrollBehaviorX: "contain",
          overscrollBehaviorY: "contain",
          WebkitOverflowScrolling: "auto",
          touchAction: "none",
        }}
      >
        <div
          className="absolute left-0 top-0"
          style={{
            width: `${layout.width}px`,
            height: `${layout.height}px`,
            transform: `translate(${viewport.x}px, ${viewport.y}px)`,
          }}
          onDoubleClick={handleGraphDoubleClick}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: `${layout.width}px`,
              height: `${layout.height}px`,
              transform: `scale(${viewport.scale})`,
            }}
          >
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              {relationPlacements.map((placement) => {
                const { relation } = placement;
                const parent = layout.positionedTables.get(relation.toTable);
                const child = layout.positionedTables.get(relation.fromTable);
                if (!parent || !child) return null;

                const parentColumn = parent.columns.find((column) => column.name === relation.toColumn);
                const childColumn = child.columns.find((column) => column.name === relation.fromColumn);
                if (!parentColumn || !childColumn) return null;

                const startX = columnAnchorX(parent, parentColumn);
                const sourceSpread = fanOffset(placement.sourceFanIndex, placement.sourceFanCount);
                const targetSpread = fanOffset(placement.targetFanIndex, placement.targetFanCount);
                const startY = columnY(parent, relation.toColumn);
                const endX = columnAnchorX(child, childColumn);
                const endY = columnY(child, relation.fromColumn);
                const laneOffset = sourceSpread + targetSpread;

                return (
                  <g key={`${relation.fromTable}:${relation.fromColumn}:${relation.toTable}:${relation.toColumn}`}>
                    <path
                      d={relationPath(startX, startY, endX, endY, laneOffset)}
                      fill="none"
                      stroke="rgba(15,118,110,0.28)"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </g>
                );
              })}
            </svg>

            {[...layout.positionedTables.values()].map((table) => (
              <div
                key={table.name}
                className="absolute overflow-hidden rounded-[10px] bg-card/96 shadow-[0_8px_22px_rgba(15,23,42,0.05)] ring-1 ring-line/70"
                style={{
                  left: `${table.x}px`,
                  top: `${table.y}px`,
                  width: `${table.width}px`,
                }}
              >
                <div className="border-b border-line/70 bg-hover/55 px-4 py-2.5 text-center">
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold text-ink">
                    {table.name}
                  </div>
                </div>

                <div>
                  {table.columns.map((column) => (
                    <div
                      key={`${table.name}:${column.name}`}
                      className={cn(
                        "relative border-b border-line/55 px-4 py-2 text-[11px]",
                        column.isForeignKey || column.isReferencedKey
                          ? "bg-accent-soft/25 text-ink"
                          : "bg-card text-muted",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="flex min-w-0 items-start gap-2">
                          {column.isForeignKey ? (
                            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[#6f7d78]" />
                          ) : column.isReferencedKey ? (
                            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />
                          ) : (
                            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-line/90" />
                          )}
                          <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-ink">
                            {column.name}
                          </span>
                        </span>
                        {(column.isForeignKey || column.isReferencedKey) && (
                          <span className="shrink-0 rounded-[6px] bg-card/95 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint ring-1 ring-line/60">
                            {column.isForeignKey && column.isReferencedKey
                              ? "FK/PK"
                              : column.isForeignKey
                                ? "FK"
                                : "PK"}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {table.remainingColumns > 0 && (
                  <div className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => toggleExpandedTable(table.name)}
                      className="ml-auto block text-[10px] font-medium text-faint transition-colors hover:text-ink"
                    >
                      Show all columns
                    </button>
                  </div>
                )}

                {table.remainingColumns === 0 && expandedTables.has(table.name) && (
                  <div className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => toggleExpandedTable(table.name)}
                      className="ml-auto block text-[10px] font-medium text-faint transition-colors hover:text-ink"
                    >
                      Show fewer columns
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line/60 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Current DB</p>
            <div className="mt-0.5 flex items-center gap-2">
              <DbIcon engine={dbEngine(props.canvasDb)} className="h-4 w-4 shrink-0" />
              <p className="truncate text-[15px] font-semibold text-ink">{props.canvasDb}</p>
            </div>
            <div className="mt-2 flex items-center gap-3 text-[11px] text-faint">
              <span className="inline-flex items-center gap-1">
                <Database className="h-3.5 w-3.5" />
                {graph ? `${graph.tables.length} tables` : schemaLoading ? "Loading schema…" : "No schema loaded yet"}
              </span>
              <span className="inline-flex items-center gap-1">
                <Link2 className="h-3.5 w-3.5" />
                {graph ? `${graph.relations.length} relations` : schemaLoading ? "Building relational graph…" : "Schema graph unavailable"}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end">
            {graph && (
              <button
                type="button"
                onClick={toggleAllExpandedTables}
                className="rounded-full border border-line/70 bg-card/90 px-3 py-1 text-[10px] font-medium text-faint transition-colors hover:text-ink"
              >
                {allTablesExpanded ? "Collapse all columns" : "Expand all columns"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {!graph || !layout ? (
          <div className="rounded-3xl border border-dashed border-line bg-card/60 px-4 py-5 text-[12px] leading-6 text-muted">
            <p className="font-medium text-ink">Schema graph is not available yet.</p>
            <p className="mt-1">
              {schemaLoading
                ? "Loading the current database schema and building its relational graph…"
                : "We couldn't load the current database schema yet. Try reopening this panel or refreshing the canvas."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-faint">
              <GitBranch className="h-3.5 w-3.5" />
              Relational graph
            </div>
            <div className="flex items-center gap-2 text-[10px] text-faint">
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-accent" />
                Primary Key
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#6f7d78]" />
                Foreign Key
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setGraphExpanded((current) => !current)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line/70 bg-card/90 text-faint transition-colors hover:text-ink"
              aria-label={graphExpanded ? "Close expanded schema graph" : "Expand schema graph"}
              title={graphExpanded ? "Close expanded schema graph" : "Expand schema graph"}
            >
              {graphExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
              {!graphExpanded && renderGraphCanvas(false)}
            </div>
            <div className="flex justify-end text-[10px] text-faint">Drag to move · scroll to zoom · double-click to reset</div>

            <div className={cn("space-y-2", graphExpanded && "hidden")}>
              <button
                type="button"
                onClick={() => setRelationsOpen((current) => !current)}
                className="flex w-full items-center justify-between border-t border-line/60 px-0 pt-3 text-left"
              >
                <div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-faint">Relations</div>
                  <div className="mt-1 text-[11px] text-faint">
                    {relations.length === 0
                      ? "No foreign-key relations detected"
                      : `${relations.length} table links`}
                  </div>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-faint transition-transform",
                    relationsOpen && "rotate-180",
                  )}
                />
              </button>

              {relationsOpen &&
                (relations.length === 0 ? (
                  <div className="rounded-2xl border border-line/70 bg-card/70 px-3 py-2 text-[12px] text-muted">
                    No foreign-key relations were detected in this schema.
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {relations.map((relation) => (
                      <div
                        key={`relation:${relation.fromTable}:${relation.fromColumn}:${relation.toTable}:${relation.toColumn}`}
                        className="rounded-2xl border border-line/70 bg-card/70 px-3 py-3"
                      >
                        <div className="text-[13px] font-medium text-ink">{relationTitle(relation)}</div>
                        <div className="mt-1 text-[11px] text-faint">{relationDescription(relation)}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-hover px-2 py-1 text-[10px] font-medium text-ink">
                            FK {relation.fromTable}.{relation.fromColumn}
                          </span>
                          <span className="text-[10px] text-faint">→</span>
                          <span className="rounded-full bg-accent-soft px-2 py-1 text-[10px] font-medium text-accent">
                            PK {relation.toTable}.{relation.toColumn}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
    {graphExpanded &&
      createPortal(
        <div className="fixed inset-0 z-[999]">
          <div className="absolute inset-0 bg-[rgba(248,250,252,0.72)] backdrop-blur-[2px]" onClick={() => setGraphExpanded(false)} />
          <div className="absolute inset-[48px] flex flex-col gap-4 rounded-[28px] border border-line/70 bg-card/96 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.14)]">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-faint">
                  <GitBranch className="h-3.5 w-3.5" />
                  Relational graph
                </div>
                <div className="flex items-center gap-2 text-[10px] text-faint">
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-accent" />
                    Primary Key
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-[#6f7d78]" />
                    Foreign Key
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={toggleAllExpandedTables}
                  className="rounded-full border border-line/70 bg-card/90 px-3 py-1 text-[10px] font-medium text-faint transition-colors hover:text-ink"
                >
                  {allTablesExpanded ? "Collapse all columns" : "Expand all columns"}
                </button>
                <button
                  type="button"
                  onClick={() => setGraphExpanded(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line/70 bg-card/90 text-faint transition-colors hover:text-ink"
                  aria-label="Close expanded schema graph"
                  title="Close expanded schema graph"
                >
                  <Minimize2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            {renderGraphCanvas(true)}
            <div className="flex justify-end text-[10px] text-faint">Drag to move · scroll to zoom · double-click to reset · press Esc to close</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
