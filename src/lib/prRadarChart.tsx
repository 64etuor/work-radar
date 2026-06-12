import { lazy, Suspense } from "react";

import type { ReadinessBucket } from "@/bindings";

export type BucketChartDatum = {
  key: ReadinessBucket;
  label: string;
  shortLabel: string;
  value: number;
  fill: string;
};

const PrBucketDistributionChartPanel = lazy(async () => {
  const { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } =
    await import("recharts");

  return {
    default: function PrBucketDistributionChartPanel({ data }: { data: BucketChartDatum[] }) {
      return (
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={data} margin={{ top: 10, right: 6, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="var(--color-wr-border-light)" vertical={false} />
            <XAxis
              dataKey="shortLabel"
              tick={{ fill: "var(--color-wr-subtle)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: "var(--color-wr-subtle)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={30}
            />
            <Tooltip
              cursor={{ fill: "var(--color-wr-elevated)" }}
              contentStyle={{
                background: "var(--color-wr-bg)",
                border: "1px solid var(--color-wr-border-light)",
                borderRadius: "var(--radius-sm)",
                color: "var(--color-wr-fg)",
                fontSize: 12,
              }}
              labelStyle={{ color: "var(--color-wr-muted)", fontWeight: 600 }}
            />
            <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map((entry) => (
                <Cell key={entry.key} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    },
  };
});

export function PrBucketDistributionChart({ data }: { data: BucketChartDatum[] }) {
  return (
    <Suspense
      fallback={<div className="pr-bucket-chart-skeleton" style={{ height: 190 }} aria-hidden />}
    >
      <PrBucketDistributionChartPanel data={data} />
    </Suspense>
  );
}
