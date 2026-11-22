# Eta template variables

Point Eta's `views` option at this directory and render by filename without the extension. For example:

```ts
import { Eta } from 'eta';
import { resolve } from 'node:path';

const eta = new Eta({ views: resolve('templates') });
const html = eta.render('cafoa', {
  serialNumber: '2026-11-0001',
  payeeName: 'Example Payee',
  details: [
    { function: '1011', allotmentClass: '100', expenseCode: '5-01-01-010', amount: '1,250.00' },
  ],
});
```

Pass dates, codes, and amounts as display strings to preserve formatting and leading zeros. Amounts also accept numbers, including zero. Missing or null scalar values render blank unless a default is listed below. Templates display the values supplied by the caller.

## CAFOA (`cafoa.eta`)

| Variable                                              | Display value                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serialNumber`                                        | Document serial number in the HTML title and metadata.                                                                                           |
| `logoSrc`                                             | Municipal logo URL or path. Defaults to `magpet-logo.png`, which resolves relative to the rendered HTML. The source logo is in `doc_templates/`. |
| `payeeName`                                           | Payee name.                                                                                                                                      |
| `amount`                                              | Total amount requested.                                                                                                                          |
| `amountWords`                                         | Total amount requested in words.                                                                                                                 |
| `officialName`, `officialTitle`, `officialDate`       | Requesting official's name, title, and date.                                                                                                     |
| `obligationNumber`                                    | Obligation number.                                                                                                                               |
| `approvedAmount`                                      | Approved amount.                                                                                                                                 |
| `signatory1Name`, `signatory1Title`, `signatory1Date` | Appropriation certification signatory.                                                                                                           |
| `signatory2Name`, `signatory2Title`, `signatory2Date` | Funds availability certification signatory.                                                                                                      |
| `signatory3Name`, `signatory3Title`, `signatory3Date` | Obligation certification signatory.                                                                                                              |
| `details`                                             | Request rows.                                                                                                                                    |
| `ledgers`                                             | Subsidiary ledger rows.                                                                                                                          |

Missing or null row arrays default to empty arrays. Put a `null` in either array to print a blank row at that position.

| Row         | Fields in display order                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| `details[]` | `function`, `allotmentClass`, `expenseCode`, `amount`                                |
| `ledgers[]` | `date`, `particulars`, `liquidations`, `obligation` (obligation increase), `balance` |

## RAAO registers

`raaoco.eta` (Capital Outlay), `raaofe.eta` (Financial Expenses), `raaomooe.eta` (Maintenance and Other Operating Expenses), and `raaops.eta` (Personal Services) share the same inputs. Each entry template supplies its own `documentCode` and `allotmentClass` to the internal `_raao.eta` layout.

| Variable                 | Display value                                          |
| ------------------------ | ------------------------------------------------------ |
| `serialNumber`           | Document serial number in the HTML title and metadata. |
| `reportingMonth`         | Month and year, e.g. `November 2026`.                  |
| `fund`                   | Fund name or code.                                     |
| `sheetNumber`            | Sheet number.                                          |
| `functionProgramProject` | Function, program, or project code.                    |
| `budgetRows`             | Rows under A. Budget.                                  |
| `actualRows`             | Rows under B. Actual.                                  |

Both arrays accept row objects and `null` entries for blank rows. Each missing or null array prints five blank rows as in the HTML reference. Pass `[]` for a section with zero rows.

| Row field             | Display value                                                       |
| --------------------- | ------------------------------------------------------------------- |
| `appropriationAmount` | Amount of appropriation.                                            |
| `allotmentAmount`     | Amount of allotment.                                                |
| `date`                | Transaction date.                                                   |
| `referenceNumber`     | Reference or CAFOA number.                                          |
| `particulars`         | Transaction description.                                            |
| `totalAmount`         | Total amount of allotment or obligation.                            |
| `details`             | Up to eight values in column order. Omitted positions render blank. |

## SAAOB (`saaob.eta`)

| Variable                              | Display value                                          |
| ------------------------------------- | ------------------------------------------------------ |
| `serialNumber`                        | Document serial number in the HTML title and metadata. |
| `startDate`, `endDate`                | Display dates for the period heading.                  |
| `preparedByName`, `preparedByTitle`   | Preparer's name and position.                          |
| `certifiedByName`, `certifiedByTitle` | Certifier's name and position.                         |
| `offices`                             | Office groups in display order.                        |
| `grandTotals`                         | Financial values for the grand total row.              |

| Nested object                      | Fields                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `offices[]`                        | `name`, optional `code`, `categories` (array), `totals` (office total).   |
| `offices[].categories[]`           | `name`, `entries` (array), `totals` (category total).                     |
| `offices[].categories[].entries[]` | `name` (entry label), `accountCode`, and the five financial fields below. |

Financial fields shared by entries, `totals`, and `grandTotals` are `appropriations`, `allotment`, `appropriationBalance`, `obligation`, and `balance`. Provide the calculated totals at each level. Missing totals render blank cells. Missing or null group and entry arrays render no rows for that array.
