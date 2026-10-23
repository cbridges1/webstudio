const ensureProtocol = (domain: string) => {
  try {
    const url = new URL(domain);
    // "localhost:56950" parses as a URL with the scheme "localhost:".
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url;
    }
  } catch {
    // A bare host; add the protocol below.
  }
  const url = new URL(`//${domain}`, "https://default.invalid");
  url.protocol = "https:";
  return url;
};

export const getPublishUrl = ({
  domain,
  pathname,
  password,
  username,
}: {
  domain: string;
  pathname: string;
  username?: string;
  password?: string;
}) => {
  const url = ensureProtocol(domain);
  url.pathname = pathname || "/";

  if (username && password) {
    url.username = username;
    url.password = password;
  }

  return url;
};
