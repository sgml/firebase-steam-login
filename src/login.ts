import { StoredToken, OAuthTokenResponse } from "./types/OAuthToken.d";
import * as express from "express";
import * as admin from "firebase-admin";
import * as querystring from "querystring";
import { validClients, jwtPublic, jwtSecret, discordClientId, discordClientSecret } from "./config";
import { SteamProfileResult } from "./types/ISteamProfileResults";
import { AlreadyLinkedError, User } from "./user.model";
import * as promisify from "typed-promisify";
import * as jwt from "jsonwebtoken";
import { asyncRequestRedirectOnError, asyncRequest, asyncMiddleware } from "./utils";
import * as request from "request-promise";
const jwtSign = promisify.promisify<object, string, jwt.SignOptions, string>(jwt.sign);

/**
 * Function to be passsed to the SteamStrategy. Creates the firebase user
 * if it doesn't exists and updates name and profile image to match steam's.
 *
 * Resolves
 *
 * @param accessToken
 * @param profile
 */
export async function handleSteamLogin(accessToken: string, steamProfile: SteamProfileResult): Promise<User> {
  const firebaseProfiles = (await admin.database().ref("profiles").orderByChild("steam/steamid").equalTo(steamProfile.id.toString()).once("value")).val();
  let existingUserId: string;
  if (firebaseProfiles && Object.keys(firebaseProfiles).length > 0) {
    existingUserId = Object.keys(firebaseProfiles)[0];
  }
  let firebaseUser = existingUserId && await admin.auth().getUser(existingUserId);

  if (!firebaseUser) {
    firebaseUser = await admin.auth().createUser({
      emailVerified: false,
      email: steamProfile.id + "@steamcommunity.com",
      displayName: steamProfile.displayName,
      photoURL: steamProfile.photos[2].value,
      disabled: false
    });
  } else {
    // On Login update name and avatar
    firebaseUser = await admin.auth().updateUser(existingUserId, {
      displayName: steamProfile.displayName,
      photoURL: steamProfile.photos[2].value,
    });
  }

  await admin.app().database().ref(`profiles/${firebaseUser.uid}`).update({
    displayName: steamProfile.displayName,
    photoURL: steamProfile.photos[2].value,
    steam: steamProfile._json
  });

  const userProfile = await admin.app().database().ref(`profiles/${firebaseUser.uid}`).once("value");
  return Object.assign({}, userProfile, firebaseUser);
}

/**
 * Gets a discord auth token form a refresh token containing properties such as
 * expiration and scope.
 * @param refreshToken refresh token
 */
async function getDiscordTokenFromRefreshToken(refreshToken: string): Promise<StoredToken> {
  const body = querystring.stringify({
    refresh_token: refreshToken,
    client_id: discordClientId,
    client_secret: discordClientSecret,
    grant_type: "refresh_token"
  });
  console.log(body);

  return await Promise.resolve(request.post("https://discordapp.com/api/oauth2/token", {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": body.length
    },
    body,
    json: true
  }).then((token: OAuthTokenResponse): StoredToken => {
    return {
      access_token: token.access_token,
      expires: new Date().getTime() + token.expires_in,
      refresh_token: refreshToken,
      token_type: token.token_type,
      scope: token.scope
    };
  }));
}

/**
 * Function called after a Firebase Authenticated user (stored in session.userId)
 * has logged in to link their Discord account. Stores the discord profile into the
 * user's profile and returns the user.
 */
export const handleDiscordLogin = asyncMiddleware.bind(undefined,
  async function handleDiscordLogin(req: express.Request) {
    const userId = req.session.userId;
    if (!userId) {
      throw new Error("Invalid Session: userId missing");
    }

    const firebaseUser = await admin.auth().getUser(userId);
    if (!firebaseUser) {
      throw new Error("Invalid Firebase User in Session id:" + userId);
    }

    const userProfile = await admin.app().database().ref(`profiles/${userId}`).once("value");
    if (!userProfile) {
      throw new Error(`User ${userId} has no profile!`);
    }
    if (userProfile.discord && userProfile.discord.id != req.user.discordProfile.id) {
      throw new AlreadyLinkedError();
    }

    // Get extended token info and store all info into the database
    await Promise.all([
      admin.app().database().ref(`profiles/${userId}`).update({
        discord: req.user.discordProfile
      }),
      admin.app().database().ref(`tokens/${userId}`).update({
        discord: await getDiscordTokenFromRefreshToken(req.user.refreshToken)
      })
    ]);
  }
);

/**
 * Express controller function that redirects the user back to the auth requesting
 * application with a firebase Token. Called at the end of the authentication chain.
 */
export const redirectWithToken = asyncRequestRedirectOnError.bind(undefined,
  async function redirectWithToken(req: express.Request, res: express.Response) {
    const user = req.user as User;
    // This should never happen as we're in an oauth callback
    if (!user) {
      throw new Error("Invalid user - not logged in?");
    }

    const redirectUrl = validClients[req.session.client_id];
    if (!redirectUrl) {
      throw new Error("Invalid Session: Invalid client_id");
    }

    const provider = req.session.provider;
    if (!provider) {
      throw new Error("Invalid Session: Invalid provider.");
    }

    const query: any = {
      provider
    };

    if (provider == "steam") {
      // Create a firebase auth token and redirect the user
      const token = await admin.auth().createCustomToken(user.uid);
      query.token = token;
    } else if (provider == "discord") {
      // We don't pass the token here as it's in the firebase db and should be
      // fetched there by the app.
    } else {
      throw new Error("Unhandled provider " + provider);
    }

    const queryStr = querystring.stringify(query);
    res.redirect(`${redirectUrl}?${queryStr}`);
  }
);

/**
 * Generates a JWT with a session time of a month.
 */
export const generateLonglivedToken = asyncRequest.bind(undefined,
  async function generateLonglivedToken(req: express.Request, res: express.Response) {
    if (!req.body.idToken) {
      throw new Error("Missing id token");
    }

    const parsedToken = await admin.app().auth().verifyIdToken(req.body.idToken);

    const payload = {
      uid: parsedToken.uid
    };
    const options: jwt.SignOptions = {
      issuer: "firebase-steam-login",
      expiresIn: "30d",
      algorithm: "RS256",
      subject: parsedToken.uid,
      audience: parsedToken.aud
    };

    const token = await jwtSign(payload, jwtSecret, options);
    const decoded = jwt.decode(token) as any;
    res.json({ token, expires: decoded.exp * 1000 });
  }
);

/**
 * Returns JWT Public Key for token verification.
 */
export function getJwtPublicKey(req: express.Request, res: express.Response) {
  res.json({ key: jwtPublic });
}
