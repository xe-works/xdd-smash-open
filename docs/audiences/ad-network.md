## Ad Network

## What it is, in your terms

Same request in. More value out.

As an ad network, you already run your own bidding engine and optimization logic. 
The question is not whether you can build something: it is how much engineering time 
each experiment costs you.

xdd-smash is a framework you run on your own infrastructure. It sits in the pipeline 
between your supply and your demand, and gives your developers a place to put logic 
on the request path. It also brings the parts nobody wants to build twice: 
the pipeline itself, isolation between features and a way to run a feature on part 
of the traffic. 

Enrich outgoing requests to a specific demand partner, drop what you never wanted to send, 
split the traffic and compare. What goes in is yours to decide.

Fast path to start, no pipeline to build, and the features always stay yours.

## Example

When a DSP recognizes the user, the bid goes up. Adding an identifier before the request 
goes out raises what it is worth, but the lookup costs money and adds milliseconds to 
every call. And it won’t pay off everywhere.

That's where xdd-smash comes in. You run the enrichment on a slice of the traffic 
first: one geo, one demand partner, or any other segment. The rest goes out as before, 
giving you two groups to compare.

The results show where the extra value justifies the cost, so you can decide where 
to take it further.
