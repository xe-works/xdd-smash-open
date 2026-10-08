## Curator

## What it is, in your terms

Your data and rules at bid time.

As a curator, you package a view of the inventory and sell it 
as a deal ID. Today most of it has to be expressed in the fields 
that someone else's platform gives you.

xdd-smash is a framework you run on your own infrastructure. 
Requests pass through it on the way to demand, and your rules run there: 
which impressions belong in a package, what they carry, and which bids 
come back through you.

A rule is a function, not a row in a list or a threshold. It reads the 
request as it passes and decides.

## What it does not replace
**Your SSP.** Whoever your deals are sold through keeps that relationship. 
The framework runs the rules behind a package and does not make a deal buyable.

**Your data partnerships.** Segments, identity and measurement come 
from wherever they come from now.

**Your reporting.** Whether a rule improved the package is 
something your own numbers answer.

## Example

A publisher list is a decision made once and true for a while. The underlying 
signals keep changing, and the list is updated on whatever cycle you can manage. 
A rule reads the request instead: what is in it now decides whether 
it belongs in the package.

A buyer complains that a package underperforms on one type of source. In a list, 
keeping that source for everyone else means a second package, with its own settings. 
A rule can weigh a segment, a content signal and what you have seen from that 
source in this package, and decide per request.

Each of these is one rule, scoped to one package.
