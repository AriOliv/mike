#!/usr/bin/perl
# Resolves diff3 conflict hunks whose sides are one-line word lists (the
# sentryPrivacy ROUTE_PARTS set, scriptedDb's filter list): keeps ours and
# appends the words only theirs has. Used by update-preview.sh.
s{^<<<<<<< [^\n]*\n(.*?)^\|\|\|\|\|\|\| [^\n]*\n.*?^=======\n(.*?)^>>>>>>> [^\n]*\n}{
  my ($o, $t) = ($1, $2);
  my %seen = map { $_ => 1 } ($o =~ /[\w-]+/g);
  my @add = grep { !$seen{$_}++ } ($t =~ /[\w-]+/g);
  if ($o =~ /^(.*\(\(?['"])(.*?)(['"]\)?\.split.*)$/s) {          # 'a b c'.split(' ')
    "$1$2" . (@add ? " @add" : "") . $3
  } elsif ($o =~ /^(.*\[)(.*?)(\].*)$/s) {                          # ["a", "b"]
    my ($pre, $mid, $post) = ($1, $2, $3);
    $pre . $mid . join("", map { qq(, "$_") } grep { /^[a-z]+$/i } @add) . $post
  } else { "$o$t" }
}gmse;
