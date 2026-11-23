import React from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { motion } from "motion/react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const fmt = (n) => n.toLocaleString("en-GB");

// A chart with an accessible table alternative behind a Chart / Table switch.
export function ChartCard({ title, description, table, className, children }) {
  return (
    <Card className={className}>
      <Tabs defaultValue="chart" className="gap-0">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="text-base">{title}</CardTitle>
            {description && <CardDescription className="max-w-prose">{description}</CardDescription>}
          </div>
          <TabsList className="shrink-0">
            <TabsTrigger value="chart">Chart</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
          </TabsList>
        </CardHeader>
        <CardContent className="pt-4">
          <TabsContent value="chart">{children}</TabsContent>
          <TabsContent value="table">
            <div className="max-h-80 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {table.columns.map((c, i) => (
                      <TableHead key={c} className={i > 0 ? "text-right" : ""}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.rows.map((r, i) => (
                    <TableRow key={i}>
                      {r.map((c, j) => (
                        <TableCell key={j} className={j > 0 ? "text-right tabular-nums" : ""}>
                          {typeof c === "number" ? fmt(c) : c}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </CardContent>
      </Tabs>
    </Card>
  );
}

const monthlyConfig = { value: { label: "Collisions", color: "var(--chart-1)" } };

// Vertical bars for change over time. data: [{ key, label, tick, value }]
export function MonthlyChart({ data }) {
  return (
    <ChartContainer config={monthlyConfig} className="aspect-auto h-[280px] w-full">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="key"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={data.length > 12 ? 0 : "preserveStartEnd"}
          minTickGap={6}
          tickFormatter={(_, i) => data[i]?.tick ?? ""}
        />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={fmt} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, p) => p?.[0]?.payload?.label}
              formatter={(v) => (
                <div className="flex w-full items-center justify-between gap-6">
                  <span className="text-muted-foreground">Collisions</span>
                  <span className="font-sans font-medium tabular-nums">{fmt(v)}</span>
                </div>
              )}
            />
          }
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={32} />
      </BarChart>
    </ChartContainer>
  );
}

// Horizontal bars with direct value labels, for comparing named categories.
// data: [{ key, label, value, note, series }]
export function BarList({ data, unit = "collisions", format = fmt, onSelect, selectedKey }) {
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <div className="flex flex-col gap-0.5">
      {data.map((d) => {
        const Row = onSelect ? "button" : "div";
        return (
          <Tooltip key={d.key}>
            <TooltipTrigger asChild>
              <Row
                type={onSelect ? "button" : undefined}
                onClick={onSelect ? () => onSelect(d.key) : undefined}
                className={cn(
                  "grid w-full grid-cols-[minmax(6rem,34%)_1fr_auto] items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm",
                  onSelect && "cursor-pointer transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  selectedKey === d.key && "bg-muted font-semibold",
                )}
              >
                <span className="truncate">{d.label}</span>
                <span className="block h-3.5">
                  <motion.span
                    className="block h-full rounded-r-[4px]"
                    style={{ background: d.series === 2 ? "var(--chart-2)" : "var(--chart-1)", minWidth: d.value > 0 ? 2 : 0 }}
                    initial={false}
                    animate={{ width: `${(d.value / max) * 100}%` }}
                    transition={{ type: "spring", stiffness: 140, damping: 24 }}
                  />
                </span>
                <span className="min-w-[5.5rem] text-right tabular-nums">
                  {format(d.value)}
                  {d.note && <span className="text-muted-foreground text-xs font-normal"> {d.note}</span>}
                </span>
              </Row>
            </TooltipTrigger>
            <TooltipContent side="top">
              {d.label}: {format(d.value)} {unit}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
