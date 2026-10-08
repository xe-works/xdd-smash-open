## SSP

## What it is, in your terms

Shaping logic and floor decisions your platform has no field for.

As an SSP, you already run the auction. The question is what it 
costs you to change the logic behind the decisions around it.

xdd-smash is a framework you run on your own infrastructure. 
The logic you write is a plain function, and the framework takes 
care of the rest: it runs on every call, keeps one function from 
breaking another and decides what happens when one fails.

A rule can run in four places: as the request arrives, as it 
goes out to each DSP, as each bid comes back, and once all bids are in. 
On the outgoing step it decides both who gets the request 
and what floor it carries. 

It can be scoped to one supply endpoint, a single publisher 
or integration, and touch nothing else, or to a slice of traffic, 
so a second version can run against the first. 

Start with one rule. Keep everything you write under your ownership.

## What it does not replace

**Your platform.** Auction winner selection, billing, publisher 
management and your DSP contracts stay where they are. 

**Your analytics.** The framework runs your rule. Whether it earned 
more is something your own reporting knows. 

## Example

You already shape traffic, and the model that does it is trained on all 
of it at once. What demand partners ask for is a different question.

One publishes Dynamic Traffic Engine (DTE) signals, and the standard 
leaves the enforcing to you. Another wants fewer banner requests, except 
on a deal they already buy on. A third is close to their QPS ceiling, 
and there is inventory you have promised will keep going out.

Each of these is one function, on one partner's outgoing step. 
What it does is yours to write.
