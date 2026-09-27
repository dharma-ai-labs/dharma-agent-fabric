# Initial Observation

The synthetic ledger currently deduplicates execution attempts. A retry using a
new attempt ID can therefore apply a logical job twice. The public retry test
is expected to fail before the coding agent repairs the defect.

This report is development evidence. It is not a private grader, measured
customer result, or proof that an automatic learning cycle has completed.
