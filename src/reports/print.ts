import { decimalCents, financialMetrics } from './financial.js';
import type { FinancialReport } from './financial.js';

export function financialPrintView(report: FinancialReport) {
  const { source, filters, facets, chart } = report;
  const fiscalYear = (year: number | null) => year === null ? 'Fiscal year unavailable' : `Fiscal year ${year}`;
  const period = source.period.fromDate && source.period.toDate ? `${source.period.fromDate} to ${source.period.toDate}` : 'Coverage dates unavailable';
  const selectedDates = filters.fromDate || filters.toDate ? `${filters.fromDate ?? 'Any start'} to ${filters.toDate ?? 'Any end'}` : 'All available dates';
  const selectedOffices = filters.officeIds.map((id) => facets.offices.find((office) => office.id === id)?.label ?? id ?? 'Unassigned office');
  const selectedCategories = filters.categories.map((category) => category ?? 'Uncategorized');
  const abs = (value: bigint) => value < 0n ? -value : value;
  return {
    sourceTitle: source.title, revisionNumber: source.revisionNumber, finalizedAt: source.finalizedAt,
    fiscalYear: fiscalYear(source.period.fiscalYear), period, periodMatched: report.periodMatched,
    filters: [
      { label: 'Fiscal year', value: filters.fiscalYear === null ? 'Any fiscal year' : String(filters.fiscalYear) },
      { label: 'Date filter', value: selectedDates },
      { label: 'Offices', value: selectedOffices.join(', ') || 'All offices' },
      { label: 'Categories', value: selectedCategories.join(', ') || 'All categories' },
    ],
    metrics: report.metrics, snapshotId: report.snapshotId, groupBy: { office: 'Office', category: 'Category',
      officeCategory: 'Office and category' }[chart.groupBy],
    breakdown: report.breakdown, omittedGroups: chart.omittedGroups,
    charts: report.metrics.map(({ metric }) => {
      const points = chart.points.flatMap(({ label, values }) => {
        const amount = values.find((point) => point.metric === metric)?.amount;
        return amount == null ? [] : [{ label, amount, cents: decimalCents(amount) }];
      });
      const max = points.reduce((highest, { cents }) => abs(cents) > highest ? abs(cents) : highest, 0n);
      return { label: financialMetrics[metric], points: points.map(({ label, amount, cents }) => ({ label, amount,
        width: max === 0n ? 0 : Number(abs(cents) * 100n / max), negative: cents < 0n })) };
    }).filter(({ points }) => points.length),
  };
}

export type FinancialPrintView = ReturnType<typeof financialPrintView>;
