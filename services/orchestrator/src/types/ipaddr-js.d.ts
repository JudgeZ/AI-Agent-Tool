declare namespace ipaddr {
  type Range = [IPv4 | IPv6, number];

  class IPv4 {
    kind(): "ipv4";
    toString(): string;
    match(range: Range): boolean;
  }

  class IPv6 {
    kind(): "ipv6";
    toString(): string;
    isIPv4MappedAddress(): boolean;
    toIPv4Address(): IPv4;
    match(range: Range): boolean;
  }

  type IPv4Range = [IPv4, number];
  type IPv6Range = [IPv6, number];
  type IPvX = IPv4 | IPv6;

  function parse(value: string): IPvX;
  function parseCIDR(value: string): [IPvX, number];
}

declare module "ipaddr.js" {
  export = ipaddr;
}
