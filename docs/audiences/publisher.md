## Publisher

## What it is, in your terms 

Your rules over your own demand paths.

As a publisher, you sell the same impression across multiple paths: 
direct integrations, SSPs, resellers. What you decide about each one is 
tied to a bidder list, ad server setup, or a config file, and it is the 
only place where you can change it. 

xdd-smash is a framework you run on your own infrastructure. Your paths 
sit behind one endpoint, and your rules run there, in logic that config 
cannot hold: which paths receive a particular impression, whether the schain 
is correct before a request reaches a demand partner, the floor you ask of 
each one, and which bids enter your auction.

## What it does not replace 

**Your auction.** Whether you use Prebid Server, your primary ad server or a 
third-party wrapper, this system still decides who competes in it and 
chooses the winner. The framework sits on one path into it.

**Your ad server pricing.** Line items and the minimum your inventory has 
to earn remain where they are. 

**Your analytics.** Whether a rule earned more is something your own 
reporting answers.

## Example 

The same first-party data segment has to arrive in a different shape for 
each demand partner. Wrapper config controls the access, but not the form. 
Behind one endpoint it is a function per partner.

Testing a new direct integration often requires building a custom adapter, 
updating configs, and waiting for a release to route traffic. With xdd-smash, 
that integration shares your main endpoint, and a routing rule decides what 
inventory it sees. 

A demand partner sends back creatives you cannot run, and turning the partner 
off costs you the fill rate on everything else they bid on. A rule can drop 
these bids as they come back, or route only part of the traffic away from that 
partner while you measure what it costs. 

Each of these is one rule, scoped to one path.
