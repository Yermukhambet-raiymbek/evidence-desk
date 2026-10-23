# Northstar demo operations handbook
This is fictional public demonstration data.
## Recovery
Database snapshots are created every six hours.
The disaster recovery objective is four hours.
Backup archives are retained for thirty days.

## Webhook delivery
Webhook delivery retries use exponential backoff.
The maximum number of webhook attempts is five.
Failed webhook deliveries enter the dead letter queue.
Support can manually replay a failed delivery.

## Security
API tokens expire after ninety days.
Token rotation must preserve a one-hour overlap period.
All audit records are retained for one year.
