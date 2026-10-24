#!/usr/bin/perl
# Resolves diff3 conflict hunks by keeping the side whose lines contain all of
# the other side's lines (a branch that only added imports/items); when
# neither contains the other, keeps both (ours then theirs). Used by
# update-preview.sh for AppSidebar.tsx, where features only add.
local $/; $_ = <>;
s{^<<<<<<< [^\n]*\n(.*?)^\|\|\|\|\|\|\| [^\n]*\n.*?^=======\n(.*?)^>>>>>>> [^\n]*\n}{
  my ($o, $t) = ($1, $2);
  my %t = map { $_ => 1 } split /\n/, $t;  my %o = map { $_ => 1 } split /\n/, $o;
  (!grep { !$t{$_} } split /\n/, $o) ? $t : (!grep { !$o{$_} } split /\n/, $t) ? $o : "$o$t"
}gmse;
print;
