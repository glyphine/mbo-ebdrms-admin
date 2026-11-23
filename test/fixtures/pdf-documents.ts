import { deriveFinancialValues } from '../../src/documents/financials.js';
import type { DocValues, TemplateCode } from '../../src/templates/contracts.js';
import { documentRegistry } from '../../src/templates/registry.js';
import { validateDocumentValues } from '../../src/templates/validation.js';

function fixture(code: TemplateCode, values: DocValues, label: string) {
  const data = validateDocumentValues(documentRegistry[code].fields, values);
  deriveFinancialValues(code, data);
  return { code, data, label };
}

const scenarios = [
  { month: '08', label: 'August', fund: 'General Fund', payee: 'Juan Dela Cruz (Sample)', amounts: ['1250.00'], liquidated: '0.00', budget: '80000.00' },
  { month: '09', label: 'September', fund: 'Special Education Fund', payee: 'Magpet Office Supplies', amounts: ['7500.00', '2250.00'], liquidated: '2500.00', budget: '120000.00' },
  { month: '10', label: 'October', fund: 'Development Fund', payee: 'Highland Public Works', amounts: ['40000.00', '15000.00', '5000.00'], liquidated: '60000.00', budget: '300000.00' },
] as const;

const registryLabels = {
  RAAOCO: ['Road resurfacing', 'Desktop equipment', 'Clinic renovation'],
  RAAOFE: ['Bank service fees', 'Loan interest', 'Financing charges'],
  RAAOMOOE: ['Office supplies', 'Facility repairs', 'Electricity'],
  RAAOPS: ['Regular salaries', 'Overtime pay', 'Personnel benefits'],
} as const;

const statementOffices: DocValues[] = [
  { name: 'Municipal Budget Office', code: '1011', categories: [{ name: 'Personal Services', entries: [
    { name: 'Salaries and Wages', accountCode: '5-01-01-010', appropriations: '900000.00', allotment: '720000.00', obligation: '540000.00' },
  ] }] },
  { name: 'Municipal Health Office', code: '1031', categories: [
    { name: 'Personal Services', entries: [{ name: 'Salaries and Wages', accountCode: '5-01-01-010', appropriations: '750000.00', allotment: '600000.00', obligation: '450000.00' }] },
    { name: 'Maintenance and Other Operating Expenses', entries: [
      { name: 'Office Supplies', accountCode: '5-02-03-010', appropriations: '90000.00', allotment: '72000.00', obligation: '54000.00' },
      { name: 'Medical Supplies', accountCode: '5-02-03-080', appropriations: '240000.00', allotment: '192000.00', obligation: '144000.00' },
    ] },
  ] },
  { name: 'Municipal Engineering Office', code: '1041', categories: [{ name: 'Capital Outlay', entries: [
    { name: 'Office Equipment', accountCode: '1-07-05-020', appropriations: '280000.00', allotment: '224000.00', obligation: '168000.00' },
    { name: 'Road Improvements', accountCode: '1-07-01-010', appropriations: '550000.00', allotment: '440000.00', obligation: '330000.00' },
  ] }] },
];

const date = (month: string, day: string) => `2026-${month}-${day}`;
const serial = (month: string, index: number) => `2026-${month}-${String(index + 1).padStart(4, '0')}`;

export const pdfFixtures = scenarios.flatMap((scenario, index) => {
  const serialNumber = serial(scenario.month, index);
  const signDate = date(scenario.month, '15');
  const total = ['1250.00', '9750.00', '60000.00'][index]!;
  const cafoa = fixture('CAFOA', {
    serialNumber, payeeName: scenario.payee, officialName: 'Alex Reyes', officialTitle: 'Requesting Official', officialDate: signDate,
    obligationNumber: `ON-${serialNumber}`, approvedAmount: total,
    signatory1Name: 'Rosa Santos', signatory1Title: 'Municipal Budget Officer', signatory1Date: signDate,
    signatory2Name: 'Cris Ramos', signatory2Title: 'Municipal Treasurer', signatory2Date: signDate,
    signatory3Name: 'Dani Flores', signatory3Title: 'Municipal Accountant', signatory3Date: signDate,
    details: [...scenario.amounts.map((amount, position) => ({ function: '1011', allotmentClass: '200',
      expenseCode: ['5-02-03-010', '5-02-03-080', '5-02-13-050'][position]!, amount })), null],
    ledgers: [{ date: signDate, particulars: 'Municipal request', liquidations: '0.00', obligation: total },
      scenario.liquidated === '0.00' ? null : { date: date(scenario.month, '25'), particulars: 'Payment voucher posted', liquidations: scenario.liquidated }],
  }, scenario.payee);

  const allotment = ['60000.00', '90000.00', '225000.00'][index]!;
  const registry = (Object.keys(registryLabels) as (keyof typeof registryLabels)[]).map((code) => fixture(code, {
    serialNumber, reportingMonth: `${scenario.label} 2026`, fund: scenario.fund, sheetNumber: `0${index + 1}`, functionProgramProject: '1011',
    budgetRows: [{ appropriationAmount: scenario.budget, allotmentAmount: allotment, date: date(scenario.month, '01'),
      referenceNumber: `BA-${scenario.month}`, particulars: 'Initial allotment', details: [allotment] }],
    actualRows: [...registryLabels[code].slice(0, index + 1).map((particulars, position) => ({
      date: date(scenario.month, String(12 + position)), referenceNumber: `ON-${serial(scenario.month, position)}`, particulars,
      details: [...Array<null>(position).fill(null), `${2500 * (index + 1) * (position + 1)}.00`],
    })), null],
  }, registryLabels[code][index]!));

  const saaob = fixture('SAAOB', {
    serialNumber, startDate: `${scenario.label} 1`, endDate: `${scenario.label} ${scenario.month === '09' ? 30 : 31}, 2026`,
    preparedByName: 'Sam Garcia', preparedByTitle: 'Budget Analyst', certifiedByName: 'Rosa Santos', certifiedByTitle: 'Municipal Budget Officer',
    offices: statementOffices.slice(0, index + 1),
  }, 'GRAND TOTAL');
  return [cafoa, ...registry, saaob];
});
